---
task: Entregar execução embutida e CLI externa com tool calling governado pelo Ralph
engine: codex
---

# Subplano S05 — Tool host e execução

## Resultado do subplano

Um modelo real ou backend CLI externo consegue executar a fixture vertical de S03 por meio de tools autorizadas. O supervisor normaliza streaming, monitora subprocessos, aplica limits e preserva output; nenhuma integração de modelo recebe poder para selecionar/concluir task ou escrever fora da policy.

## Referências obrigatórias

- `docs/03-arquitetura-e-modulos.md`
- `docs/06-providers-modelos-autenticacao-e-upstream.md`
- `docs/08-orquestracao-executor-tools-e-contexto.md`
- `docs/11-eventos-telemetria-logs-e-relatorios.md`
- `docs/13-paralelismo-git-sandbox-e-seguranca.md`

## Tarefas

- [x] S05.01 finalizar o contrato `ExecutionBackend` e o adapter de model stream para text, reasoning, tool input/call/result/error, provider warning/error, usage e finish, com validação de ordem, IDs causais, raw refs e golden fixtures de chunks parciais/retry.
- [x] S05.02 implementar tool registry/schema e as tools mínimas `fs.read`, `fs.list`, `fs.glob`, `fs.search`, `fs.write`, `fs.edit`, `fs.apply_patch`, `process.exec`, `git.inspect` e `artifact.publish`, mantendo cada tool pequena, bounded e neutra quanto ao stack do projeto.
- [x] S05.03 implementar path resolver com canonical workspace, symlink/junction checks, read/write scopes, before hashes e output limits; provar traversal/escape/concorrência de edição em Windows e Unix fixtures.
- [x] S05.04 implementar permission engine `allow|deny|ask`, risk classes, security profiles e comportamento headless, incluindo prompt TUI compartilhado via command; o judge não recebe tools de escrita e `dangerous` continua auditado.
- [x] S05.05 implementar lifecycle intent-before-effect e settlement de tool, idempotency/preconditions, timeout/cancelamento, stdout/stderr refs e recovery classification para call unsettled; nenhum tool result pode editar diretamente task/ledger.
- [x] S05.06 implementar `process.exec` preferindo executable+argv, cwd/env allowlist, shell explícito, process group/job object, two-phase cancel e redaction; adicionar testes de injection, timeout, child process e output grande.
- [x] S05.07 ligar backend embutido de provider à orchestration de S03, entregar tools filtradas por capabilities/policy, devolver settlements ao modelo e rodar a fixture até evidence/gate completion com usage/report corretos.
- [x] S05.08 implementar backend CLI externo com templates seguros de command/args, cwd/env, adapters `protocol`, `known-output` e `generic`, raw stdout/stderr e capability declaration; provar que usar CLI é uma opção separada de login por conta.
- [x] S05.09 implementar budgets independentes de model calls, tool calls, output, tokens e phase timeouts, além de cancellation/Ctrl+C, com status/event/report indicando precisamente qual limite foi atingido.
- [x] S05.10 executar adversarial E2E: modelo pede path proibido, comando destrutivo, tool inválida, declara `TASK_COMPLETE`, stream cai após write e provider troca por fallback; validar que state, diff e settlement permanecem coerentes.

## Critérios de conclusão

- Embedded e external CLI implementam o mesmo contrato mínimo.
- Todas as mutações passam pelo tool host ou por adapter explicitamente classificado.
- “Complete” em texto não muda task.
- Tool/command timeout mata a árvore correta e mantém resume.
- Raw output existe, enquanto TUI/JSON consomem eventos normalizados.
- Paths, secrets e efeitos externos respeitam policy.

## Verificação mínima

```text
ralph once --prd <fixture> --executor-profile <embedded-profile>
ralph once --prd <fixture> --executor-profile <external-cli-profile>
ralph events --format jsonl
bun test packages/tool-host packages/model-drivers packages/supervisor
```
