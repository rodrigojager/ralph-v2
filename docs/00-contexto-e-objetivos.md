# 00 — Contexto, problema e objetivos

## Contexto

O Ralph atual implementa o padrão Ralph Loop como um CLI que lê um PRD, seleciona trabalho, chama uma engine de IA, verifica alterações e atualiza o estado. A ideia essencial continua correta: o estado pertence ao arquivo, ao filesystem, ao Git e aos resultados verificáveis; não pertence à memória conversacional do modelo.

O surgimento de mecanismos de goals e agentes mais persistentes reduziu a utilidade relativa da implementação atual, mas não elimina a vantagem específica do Ralph: ciclos curtos, contexto limpo, controle determinístico e provas por tarefa.

A v2 deve recuperar essa vantagem resolvendo os problemas encontrados na prática:

- tarefas organizadas horizontalmente por camada fazem backend, frontend, infraestrutura e contratos perderem contexto entre execuções;
- engines diferentes emitem outputs, tokens e eventos incompatíveis, prejudicando a TUI;
- autenticação exclusivamente por API key ignora assinaturas já pagas e fluxos OAuth, como ChatGPT Plus/Pro com Codex;
- o próprio executor pode relaxar seu julgamento para terminar;
- tarefas complexas podem precisar de um nível adicional de detalhe sem inflar a tarefa pai;
- encerramentos, travamentos e múltiplos Ralphs precisam de estado e isolamento mais robustos;
- a configuração atual por arquivos/flags é útil, mas deve ganhar uma interface rica sem perder automação headless.

## Por que reescrever

O objetivo não é portar Go para TypeScript linha por linha. A mudança permite:

- incorporar de forma curada código de providers, protocolos LLM, autenticação e componentes de TUI do OpenCode;
- trabalhar no mesmo ecossistema de runtime e UI: TypeScript, Bun, SolidJS e OpenTUI;
- definir um contrato único de eventos e usage para providers diferentes;
- redesenhar persistência, runs filhos, judge e TUI sem carregar limitações da estrutura antiga.

A reescrita não transforma o Ralph em um frontend do OpenCode. O Ralph continuará sendo um produto e uma máquina de estados independentes.

## Resultado do produto

Um usuário deve conseguir:

1. Gerar um PRD principal e sub-PRDs com a skill apropriada.
2. Ler e editar os arquivos como Markdown comum.
3. Validá-los deterministicamente antes da execução.
4. Escolher executor e judge independentes, por TUI ou CLI.
5. Autenticar com API key, ambiente, OAuth ou assinatura quando o provider oferecer.
6. Executar uma pequena vertical slice por ciclo.
7. Acompanhar status, tarefas, barra de progresso, tokens, tools, logs e output em uma TUI padronizada.
8. Fechar o terminal ou sofrer um crash e retomar a tarefa não finalizada.
9. Usar judge externo com nota, feedback e número máximo de revisões ou operar sem judge.
10. Executar sub-PRDs e múltiplos projetos sem colisão de estado.
11. Usar exatamente os mesmos recursos de forma headless e automatizável.

## Objetivos funcionais

- Preservar `run/loop`, `wiggum`, `once`, `parallel`, dry-run, gates, no-change, fallback, checkpoints, context/repo map, Git, sandbox, logs, eventos e relatórios onde continuarem coerentes.
- Adicionar PRD v2 Markdown, sub-PRDs, perfis, provider drivers embutidos, credenciais por conta, judge, self-review, resume, workers, watchdog e TUI rica.
- Manter backend de engine CLI externo como opção de compatibilidade, sem depender dele para providers embutidos.
- Permitir defaults globais, por workspace, por PRD, por tarefa e overrides por invocação.
- Emitir contratos JSON/JSONL estáveis para integrações e extensões.

## Objetivos não funcionais

- Determinismo nas transições de estado.
- Crash safety e retomada idempotente.
- Compatibilidade com Windows como requisito de primeira classe, além de Linux e macOS.
- Nenhum segredo em logs, PRDs, eventos ou reports.
- TUI desacoplada do stream e incapaz de bloquear execução.
- Honestidade de métricas e evidências.
- Testabilidade com providers simulados e streams gravados.
- Atualização upstream controlada, auditável e reversível.

## Não objetivos imediatos

- Recriar servidor, compartilhamento de sessões, web app ou ecossistema completo de plugins do OpenCode.
- Transformar o Ralph em IDE ou editor geral.
- Permitir que modelos escrevam ou reorganizem o PRD durante um run.
- Prescrever linguagem, framework ou arquitetura para os projetos executados.
- Prometer que todo provider oferece tool calling, tokens, reasoning ou OAuth. Capacidades são descobertas e validadas por perfil.

## Critério de sucesso

O Ralph v2 é bem-sucedido quando uma vertical slice real pode ser gerada, executada, modificada, verificada, julgada, observada e retomada ponta a ponta, com o CLI mantendo autoridade em todas as etapas e produzindo o mesmo estado em TUI e headless.
