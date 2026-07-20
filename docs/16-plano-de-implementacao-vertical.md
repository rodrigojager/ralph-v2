# 16 — Sequência de implementação em vertical slices

## Como executar este roadmap

Este roadmap não organiza trabalho por “fazer domínio, depois providers, depois TUI”. Cada slice entrega um fluxo pequeno observável atravessando as camadas necessárias. O arquivo [PRD.md](../PRD.md) contém a fila mestre; cada seção abaixo aponta para um subplano parser-compatível em `implementation/`.

Regra de avanço:

1. abrir somente a próxima Sxx elegível;
2. executar todos os itens do subplano correspondente;
3. provar o cenário vertical end to end;
4. atualizar docs/schema/provenance no mesmo trabalho;
5. marcar Sxx apenas após o subplano inteiro;
6. não antecipar módulos completos de fases futuras.

## Mapa de dependências

```text
S01 -> S02 -> S03 -> S04 -> S05 -> S06 -> S07 -> S08 -> S09 -> S10 -> S11 -> S12
```

A ordem é propositalmente conservadora. Dentro de um subplano podem existir itens independentes, mas a primeira implementação deve privilegiar previsibilidade. Após S09, a própria ferramenta poderá exercer paralelismo com isolamento.

## S01 — Fundação executável e compatibilidade observável

**Resultado:** instalar/invocar `ralph-next`, inicializar workspace novo e consultar help/version/status em human e JSON sem chamar IA.

**Corte transversal:** monorepo Bun/TypeScript, entrypoint CLI, config/schema mínimo, workspace identity/state mínimo, output/event básico, packaging dev e harness black-box inicial contra Ralph clássico.

**Não inclui:** execução de task, provider real ou TUI completa.

**Prova:** binário/package executado em fixture Windows/Linux CI, init idempotente, help/exit codes e status JSON golden.

**Subplano:** [01-fundacao-e-compatibilidade.md](../implementation/01-fundacao-e-compatibilidade.md).

## S02 — Um PRD humano que compila e atualiza uma task com segurança

**Resultado:** `prd validate/inspect/migrate` lê v1 e v2, resolve child graph e altera apenas o marker de uma task numa fixture.

**Corte transversal:** CommonMark/YAML, schema/domain, diagnostics CLI/JSON, source map/atomic edit, recursive graph, examples e contrato da skill.

**Não inclui:** pedir execução a modelo.

**Prova:** golden/property tests, bytes fora do checkbox preservados, child missing/cycle recusados, v1 fixture reconhecida.

**Subplano:** [02-prd-v2-e-skill.md](../implementation/02-prd-v2-e-skill.md).

## S03 — Primeira task vertical comandada até a conclusão

**Resultado:** fake executor recebe a task selecionada pelo Ralph, propõe/produz uma alteração, Ralph coleta diff, roda command gate e marca concluída nos modos once/loop/wiggum.

**Corte transversal:** scheduler, state machine, attempt, context manifest, fake backend, no-change, verification, ledger/event/report e CLI status.

**Não inclui:** provider real, judge ou TUI rica.

**Prova:** E2E fixture completa; resposta “complete” sem diff/gate não conclui; interruption simples retoma a mesma task.

**Subplano:** [03-orquestrador-e-modos.md](../implementation/03-orquestrador-e-modos.md).

## S04 — Configurar e autenticar modelos por papel

**Resultado:** usuário escolhe executor e judge independentemente, conecta por API key/ref e pelo menos um fluxo de conta suportado, lista modelos/capabilities e faz smoke call read-only.

**Corte transversal:** vendor curado OpenCode, ports, credential store, OAuth, model catalog, config/CLI e popup inicial de seleção, events/usage.

**Não inclui:** tool host completo ou avaliação do judge.

**Prova:** mocks de auth/refresh, secrets ausentes de config/log, ChatGPT account flow quando suportado, model incompatível rejeitado, provenance completa.

**Subplano:** [04-providers-auth-e-modelos.md](../implementation/04-providers-auth-e-modelos.md).

## S05 — Modelo real trabalha por tools sem governar o Ralph

**Resultado:** backend embutido ou CLI externo executa a fixture S03 usando tool host autorizado e eventos padronizados; model output não altera state diretamente.

**Corte transversal:** request adapters, streaming, tool schemas, permissions, process supervision, output/usage normalization, cancelamento e reports.

**Não inclui:** judge scoring.

**Prova:** tool allow/deny/timeout/settlement, stream text/reasoning/tool/usage, external CLI generic, malicious completion text ignorado.

**Subplano:** [05-tool-host-e-execucao.md](../implementation/05-tool-host-e-execucao.md).

## S06 — Julgamento independente e revisão limitada

**Resultado:** a mesma task pode concluir por deterministic-only, ser autoavaliada opcionalmente ou ser avaliada por judge externo com score, parecer, threshold e até N revisões.

**Corte transversal:** evidence bundle, gate/skip policies, artifact/change-only, evaluation schema, profiles, context de revisão, CLI/config, inspeção TUI read-only das opções persistidas e report.

**Fronteira TUI:** o popup/resumo anexado mostra valores efetivos, origens e equivalentes, mas não muta o snapshot de um run existente. A command palette mutável, `Apply for this run` no fluxo pré-run e os saves workspace/global são entregas obrigatórias de S08.

**Não inclui:** watchdog completo.

**Prova:** gate falho vence score 100; score 60 causa feedback/revisão, 88 passa threshold 85; limite esgotado mantém task pendente; judge indisponível segue policy.

**Subplano:** [06-evidencias-judge-e-revisoes.md](../implementation/06-evidencias-judge-e-revisoes.md).

## S07 — Crash não perde nem pula trabalho

**Resultado:** supervisor/worker/ledger retomam a tentativa/tarefa correta após kill em pontos críticos e watchdog distingue fixture lenta de congelada.

**Corte transversal:** durable store/migrations/outbox, leases/process identity, resume/reconciliation, partial diff, worker IPC, watchdog multi-sinal, commands status/resume/stop.

**Não inclui:** child/parallel completo.

**Prova:** kill matrix mínima, completion prepared recovery, PID reuse, quiet healthy não morto, stalled recuperado dentro de budget.

**Subplano:** [07-persistencia-resume-e-watchdog.md](../implementation/07-persistencia-resume-e-watchdog.md).

## S08 — Operação rica e padronizada pela TUI

**Resultado:** TUI anexável mostra status, `n/N`, barra responsiva, árvore, tokens, activity, errors, engine output, tools, gates, judge e watchdog; antes de criar um run, command palette e popups configuram as mesmas opções do CLI, com apply no run novo e saves workspace/global. Attach/replay conserva read-only o snapshot persistido.

**Corte transversal:** event schema/replay, usage aggregation, backpressure/raw logs, IPC client, Solid/OpenTUI components, themes/keybindings/accessibility e headless JSONL.

**Não inclui:** parallel worktree final.

**Prova:** PTY resize, barra para 2/12/100 tasks com mesma proporção, TUI close/reattach, provider sem usage, output intenso sem travar heartbeat.

**Subplano:** [08-eventos-telemetria-e-tui.md](../implementation/08-eventos-telemetria-e-tui.md).

## S09 — Sub-PRDs e execução concorrente isolada

**Resultado:** root task inicia child Ralph pré-planejado, resume child primeiro e só conclui parent no fim; grupos independentes podem rodar em worktrees com integração segura.

**Corte transversal:** recursive scheduler, parent/child events/leases/bars, claims, worktrees/branches, integration gates, checkpoints/rollback, sandbox/security.

**Não inclui:** paridade de todos os comandos legados.

**Prova:** parent crash reencontra child, cycle recusado, dois projetos não colidem, parallel conflito pausa, no destructive recovery.

**Subplano:** [09-subprds-paralelismo-git-e-seguranca.md](../implementation/09-subprds-paralelismo-git-e-seguranca.md).

## S10 — Fluxos operacionais e migração lado a lado

**Resultado:** comandos relevantes do Ralph atual têm implementação/alias/diagnóstico, settings são editáveis por CLI/TUI e um workspace v1 pode ser inspecionado/migrado sem sobrescrita.

**Corte transversal:** command handlers, tasks/config/logs/reports/context/checkpoints/adapters/recipes/doctor/update/lang, compatibility harness, importer e docs.

**Não inclui:** declarar release final.

**Prova:** matriz command/flag, migrate inspect/apply/rollback fixture, old/new coexistem, JSON output estável.

**Subplano:** [10-comandos-operacionais-e-migracao.md](../implementation/10-comandos-operacionais-e-migracao.md).

## S11 — Hardening comprovado

**Resultado:** toda a matriz funcional, de crash, provider, TUI, segurança e plataforma passa ou tem limitação explicitamente aprovada.

**Corte transversal:** unit/property/golden/integration/E2E, fake kit, PTY, cross-platform CI, performance/backpressure, secret/license/SBOM e correções.

**Não inclui:** renomear `ralph-next` antes dos resultados.

**Prova:** artifacts de CI e matriz de rastreabilidade sem requisito obrigatório órfão.

**Subplano:** [11-testes-matriz-e-hardening.md](../implementation/11-testes-matriz-e-hardening.md).

## S12 — Release, skill final e handoff

**Resultado:** builds instaláveis, notices/provenance, manuais e migração; skill gera root/children válidos pelo parser final; período beta e gate de nome definidos.

**Corte transversal:** packaging/update, release automation, docs, templates/schema da skill, sample project, migration/rollback drill e support diagnostics.

**Prova:** instalação limpa em plataformas alvo, skill gera exemplos válidos recursivamente, smoke real rotulado, checksum/SBOM/license e handoff executável.

**Subplano:** [12-release-skill-e-handoff.md](../implementation/12-release-skill-e-handoff.md).

## Gate contra implementação horizontal

Antes de aceitar uma mudança, responder:

- há comportamento que um usuário/comando consegue observar agora?
- as camadas tocadas estão ligadas pelo fluxo, não apenas compilando separadamente?
- existe prova end to end proporcional?
- state/events/errors da nova capacidade aparecem?
- config TUI/CLI foi ligada se necessário?
- a próxima slice consegue partir desse contrato estável sem contexto oculto?

Se a resposta principal for “o módulo está pronto para ser usado depois”, o corte provavelmente ainda é horizontal e deve ser reduzido/recomposto.
