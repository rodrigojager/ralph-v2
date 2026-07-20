---
task: Implementar Ralph v2 como CLI autoritativo, retomável, multi-provider e orientado a vertical slices
engine: codex
---

# PRD: Ralph v2

## Resultado esperado

Entregar uma reescrita independente do Ralph em TypeScript/Bun que preserve o modelo de comando controlando a IA, mantenha os modos e contratos úteis do Ralph atual, incorpore providers/autenticação/telemetria selecionados do OpenCode e adicione PRD v2, sub-PRDs, judge, retomada, watchdog e TUI rica sem remover a operação headless por linha de comando.

## Fontes de verdade

- `AGENTS.md` contém as invariantes de implementação.
- `docs/00-*` até `docs/19-*` contêm a especificação normativa em ordem.
- `implementation/` contém o detalhamento interno de cada item deste PRD.
- O checkout antigo `C:\Users\Rodrigo\Desktop\Ralph Loop` é referência de compatibilidade e não deve ser alterado.
- O código do OpenCode só pode ser transplantado de modo curado, atribuído e fixado a um commit.

## Contexto compartilhado

- O Ralph seleciona e governa o trabalho; modelos são ferramentas subordinadas.
- O executor não cria PRDs. A skill externa/distribuível de PRD gera o plano principal e todos os sub-PRDs antes do runtime.
- Cada tarefa deve entregar um comportamento atravessando todas as camadas necessárias e possuir prova proporcional ao risco.
- A v2 deve continuar útil sem judge, sem TUI e sem API key, quando existir autenticação por conta suportada.
- Configurações do executor e do judge são independentes.
- Encerramento ou crash nunca pode fazer o Ralph pular silenciosamente uma tarefa não finalizada.
- A TUI mostra estado real, tokens, progresso, barra responsiva, logs e output por eventos normalizados; ela não estima porcentagem de trabalho interno do modelo.

## Política de conclusão

- Cada item mestre possui um subplano em `implementation/`.
- O item mestre só é concluído quando todos os checkboxes internos, testes e critérios de aceite daquele subplano estiverem concluídos.
- Gates determinísticos bloqueantes têm precedência sobre avaliações por LLM.
- Alterações derivadas do OpenCode exigem proveniência e licença no mesmo item em que forem introduzidas.
- A sequência é deliberadamente majoritariamente serial. Paralelismo só deve ser ativado após contratos e isolamento estarem estáveis.

## Fase 1 — fundação executável

- [x] S01 entregar um `ralph-next` instalável que inicializa workspace, carrega configuração versionada, oferece help/version/status em modo headless e possui harness de compatibilidade contra o Ralph atual; seguir integralmente `implementation/01-fundacao-e-compatibilidade.md` e só concluir após todos os seus itens e testes.
- [x] S02 entregar PRD v1 compatível e PRD v2 Markdown legível com parser AST, schema forte, validação recursiva, edição posicional de status, exemplos e contrato de autoria exclusiva pela skill; seguir integralmente `implementation/02-prd-v2-e-skill.md`.
- [x] S03 entregar a primeira execução completa comandada pelo CLI nos modos once, loop e wiggum, com seleção determinística, contexto controlado, tentativa limitada, no-change básico, gates e marcação somente após verificação; seguir integralmente `implementation/03-orquestrador-e-modos.md`.

## Fase 2 — providers e execução controlada

- [x] S04 entregar seleção e configuração independente de provider/model/credencial para executor e judge, incluindo API key, env, OAuth de conta/assinatura quando suportado, ChatGPT Plus/Pro para Codex/OpenAI, catálogo/capabilities e fallback, sem depender de uma sessão do OpenCode; seguir integralmente `implementation/04-providers-auth-e-modelos.md`.
- [x] S05 entregar invocação embutida de modelo e backend CLI externo sob o mesmo contrato, tool calling autorizado pelo Ralph, ferramentas mínimas de código, limites, permissões, streaming e output normalizado, sem permitir que model drivers alterem estado; seguir integralmente `implementation/05-tool-host-e-execucao.md`.

## Fase 3 — prova de conclusão

- [x] S06 entregar pipeline unificado de evidências, gates opcionais/obrigatórios, políticas de skip, no-change, change-only e artifact, self-review opcional e judge externo com nota 0–100, parecer detalhado, threshold e máximo de revisões; seguir integralmente `implementation/06-evidencias-judge-e-revisoes.md`.

## Fase 4 — durabilidade e supervisão

- [x] S07 entregar ledger transacional de runs/tarefas/tentativas, retomada automática da tarefa ativa ou primeira pendente, leases, workers, encerramento gracioso, recuperação de crash e watchdog multi-sinal que distingue lentidão de travamento; seguir integralmente `implementation/07-persistencia-resume-e-watchdog.md`.
- [x] S08 entregar event bus versionado, agregação correta de tokens, logs e output persistentes, status/progresso headless e TUI OpenTUI com painéis ricos, popups, árvore de filhos e barras de progresso responsivas baseadas em concluídas/total; seguir integralmente `implementation/08-eventos-telemetria-e-tui.md`.

## Fase 5 — hierarquia, concorrência e operação avançada

- [x] S09 entregar execução de sub-PRDs já gerados pela skill, supervisão pai/filho, isolamento entre múltiplos projetos, paralelismo com claims/worktrees, estratégias Git, checkpoints, rollback, sandbox e segurança; seguir integralmente `implementation/09-subprds-paralelismo-git-e-seguranca.md`.
- [x] S10 entregar paridade dos comandos operacionais relevantes, configuração equivalente por CLI e TUI, adapters/recipes/context/tasks/logs/reports/doctor/install/update/lang, importação segura do workspace/config antigo e caminho de migração lado a lado; seguir integralmente `implementation/10-comandos-operacionais-e-migracao.md`.

## Fase 6 — hardening e entrega

- [x] S11 validar a matriz completa com unitários, property/golden tests, fixtures de providers, PTY/TUI, falhas de rede, OAuth, crashes, watchdog, concorrência, segurança e plataformas suportadas, corrigindo toda divergência obrigatória; seguir integralmente `implementation/11-testes-matriz-e-hardening.md`.
- [x] S12 finalizar empacotamento e releases, avisos de terceiros, documentação de usuário, migração do nome `ralph-next` para `ralph` somente após gate, e adaptar a skill de geração para o schema final do PRD v2 com validação pelo mesmo parser; seguir integralmente `implementation/12-release-skill-e-handoff.md`.
