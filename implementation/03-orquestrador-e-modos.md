---
task: Entregar a primeira execução autoritativa de uma task nos modos once loop e wiggum
engine: codex
---

# Subplano S03 — Orquestrador e modos

## Resultado do subplano

Uma fixture com PRD e fake executor é processada do início ao fim: o Ralph escolhe a task, constrói contexto, registra tentativa, aceita trabalho proposto, coleta diff, roda gate, decide e atualiza marker. A mesma máquina suporta once, loop e wiggum; declarar sucesso sem prova não conclui.

## Referências obrigatórias

- `docs/01-principios-e-invariantes.md`
- `docs/02-escopo-e-modos-de-trabalho.md`
- `docs/08-orquestracao-executor-tools-e-contexto.md`
- `docs/09-evidencias-gates-judge-e-revisoes.md`
- contratos de S01/S02

## Tarefas

- [x] S03.01 implementar enums e transições puras de run/task/attempt, scheduler determinístico por dependência/ordem, selection `--task`, force auditado e testes que proíbem transição direta de model output para completed.
- [x] S03.02 criar `ExecutionBackend` fake programável e context builder que materializa invariantes, task, criteria/limits/evidence, parent/dependency outputs, baseline e budget em `ContextManifest` hashado; adicionar golden sem incluir PRD inteiro desnecessariamente.
- [x] S03.03 implementar lifecycle transacional de uma attempt, baseline Git/read-only workspace, model call fake, `ExecutorOutcome` como alegação, counters distintos e eventos/status observáveis durante cada phase.
- [x] S03.04 implementar evidence collector inicial para diff/files/artifact refs e no-change policies `require`, `allow`, `fail` e `retry`, garantindo que arquivo fora de scope seja diagnosticado e que worktree do usuário não seja resetado.
- [x] S03.05 implementar command gate genérico sem impor linguagem, incluindo argv/cwd/env refs/timeout/output refs/skip reason, e completion policy determinística em que blocking failure sempre deixa marker não concluído.
- [x] S03.06 ligar atomic marker update e ledger/outbox completion ao modo `once`, emitir report human/JSON e provar que crash/reexecução simples antes da conclusão seleciona novamente a mesma task.
- [x] S03.07 implementar `loop` com stop conditions, delay, fail-fast, max tasks/run e reconstrução de contexto por task; provar que duas tasks executam em ordem e que a segunda não começa após falha bloqueante sob fail-fast.
- [x] S03.08 implementar `wiggum` com max iterations, model calls e no-change counters separados, preservando a essência do modo atual sem usar frase do modelo como completion; adicionar fixtures de convergência e exhaustion.
- [x] S03.09 expor flags/config/help/status/events/report para os três modos, `--dry-run`, `--skip-tests`, `--skip-lint`, `--skip-gates`, `--fast`, `--no-commit` onde aplicável, com options efetivas e origem registradas.
- [x] S03.10 criar E2E empacotado de uma vertical slice fictícia que muda source e passa um command test, mais cenários adversariais “TASK_COMPLETE” sem mudança, gate falho e no-change, e atualizar compatibility report.

## Critérios de conclusão

- O fake modelo nunca escolhe task nem marca status.
- Once, loop e wiggum passam pelo mesmo evidence/completion core.
- Um gate bloqueante falho impede `[x]`.
- Context manifest e report tornam a execução reproduzível.
- Limits encerram sem loop infinito e mantêm trabalho retomável.
- Opções rápidas/skips são explícitas e auditadas.

## Verificação mínima

```text
ralph-next once --prd <fixture> --executor-profile fake
ralph-next loop --prd <fixture-two-tasks> --executor-profile fake
ralph-next run --wiggum --max-iterations 2 --prd <fixture>
ralph-next report last --format json
```

Os comandos acima descrevem a composition root de teste do subplano. O binário normal não registra `fake`; o E2E usa o perfil isolado `fixture-executor` e o mesmo command/orchestration core do produto.

## Adendo estático — fonte ad hoc de `once`

`once "descrição"` usa uma fonte persistida separada de PRD. O texto posicional nunca é resolvido
como task ID; `--task` continua sendo o seletor explícito de PRD. O runtime deriva um contrato virtual
em memória, exige evidência `change-only`, reaproveita executor/tools/judge/watchdog e conclui de forma
atômica apenas no ledger/report (`markerUpdated=false`). A descrição/hash imutáveis permitem `resume`
sem repetir texto. PRDs detectáveis entram como protected paths e um gate bloqueante recusa qualquer
criação/mutação PRD observada. Nenhum PRD/sub-PRD é criado pelo runtime. Este adendo foi revisado
apenas estaticamente; não altera a evidência histórica dos testes listados abaixo.

## Evidência exigida para fechamento

Fechamento reproduzido em 18 de julho de 2026 sobre o mesmo source fingerprint e standalone nativo. A aceitação considera o conjunto dos gates abaixo, incluindo os cenários adversariais de evidence/diff, opções efetivas por task, deadlines, raw outputs, resume e paridade marker/ledger; nenhum teste isolado foi usado como substituto da suíte integral.

- [x] `bun test`: 260 testes e 2.556 assertions verdes, incluindo unitários, integração, retomada controlada e o E2E empacotado.
- [x] `tests/integration/packaged-vertical-slice.test.ts`: executável temporário entrega mudança, passa command gate, conclui marker e valida status/eventos/report.
- [x] `bun run build` e `bun run smoke`: standalone `bun-windows-x64-baseline` fresco exercitado fora do checkout; smoke `tested` e fake ausente do artefato normal.
- [x] `bun run compat`: baseline `docs/compatibility/s01-report.*` regenerado, cinco cenários comparados em `legacy-vs-next`, zero regressões e evidência nativa.
- [x] `bun run compat:s03`: addendum `docs/compatibility/s03-addendum.*` regenerado sobre o mesmo build fresco, 15/15 checks, zero regressões e sem alterar a finalidade do baseline S01.
