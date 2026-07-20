# Curadoria de padrões externos

Esta skill é uma síntese própria para o contrato PRD v2 do Ralph. Nenhum arquivo, template,
gramática ou trecho de código das fontes abaixo foi copiado. As referências foram relidas em
2026-07-19; seus exemplos de stack, diretórios, comandos, tempos e ferramentas não são defaults do
Ralph.

## Fontes consultadas

- [mattpocock/skills — `to-issues`](https://github.com/mattpocock/skills/blob/c5a4a8c2e966e28628f56d1bfef07f401d399df0/skills/engineering/to-issues/SKILL.md)
  (`c5a4a8c2e966e28628f56d1bfef07f401d399df0`, [MIT](https://github.com/mattpocock/skills/blob/c5a4a8c2e966e28628f56d1bfef07f401d399df0/LICENSE)):
  tracer bullets verticais, resultado completo/demonstrável, dependências explícitas e
  expand/contract para refactors cujo blast radius não permite um corte verde imediato.
- [addyosmani/agent-skills — `planning-and-task-breakdown`](https://github.com/addyosmani/agent-skills/blob/2fbfa004a0192529bc997d103fc12f19a3804aab/skills/planning-and-task-breakdown/SKILL.md)
  e [`incremental-implementation`](https://github.com/addyosmani/agent-skills/blob/2fbfa004a0192529bc997d103fc12f19a3804aab/skills/incremental-implementation/SKILL.md)
  (`2fbfa004a0192529bc997d103fc12f19a3804aab`, [MIT](https://github.com/addyosmani/agent-skills/blob/2fbfa004a0192529bc997d103fc12f19a3804aab/LICENSE)):
  tarefas pequenas para uma sessão focada, acceptance/evidence/dependencies visíveis,
  working state por incremento e mapeamento explícito de oportunidades de paralelismo.
- [obra/superpowers — `writing-plans`](https://github.com/obra/superpowers/blob/d884ae04edebef577e82ff7c4e143debd0bbec99/skills/writing-plans/SKILL.md)
  e [`verification-before-completion`](https://github.com/obra/superpowers/blob/d884ae04edebef577e82ff7c4e143debd0bbec99/skills/verification-before-completion/SKILL.md)
  (`d884ae04edebef577e82ff7c4e143debd0bbec99`, [MIT](https://github.com/obra/superpowers/blob/d884ae04edebef577e82ff7c4e143debd0bbec99/LICENSE)):
  contexto suficiente para uma nova sessão, setup/config/docs dentro da slice consumidora,
  task como unidade revisável e evidência fresca antes de uma alegação de conclusão.
- [NousResearch/hermes-agent — `writing-plans`](https://github.com/NousResearch/hermes-agent/blob/c136eb4de1eae6db5acf2cc35f7e1e9e4763aea3/skills/software-development/writing-plans/SKILL.md)
  (`c136eb4de1eae6db5acf2cc35f7e1e9e4763aea3`, [MIT](https://github.com/NousResearch/hermes-agent/blob/c136eb4de1eae6db5acf2cc35f7e1e9e4763aea3/LICENSE),
  adaptada de `obra/superpowers`): granularidade pequena, paths/verification explícitos e
  handoff para executor de contexto limpo.

## Decisões adotadas

- Definir task por capacidade observável de ponta a ponta, não por camada técnica.
- Manter produtor, consumidor e contrato mínimo no mesmo contexto quando nenhum lado entrega valor
  isoladamente.
- Exigir resultado, limites, dependências reais e prova proporcional em cada slice.
- Dividir quando um revisor puder aprovar um resultado e rejeitar outro de forma independente.
- Usar expand/contract para mudanças mecânicas largas, preservando uma integração final explícita.
- Gerar root e todos os Sub-PRDs antes do runtime para que cada contexto possa ser reconstruído sem
  depender da conversa anterior.
- Tratar a alegação do executor como input, nunca como prova; preferir checks determinísticos,
  diff/artifact e, no fallback final, receipt bounded ligado à task.

## Decisões deliberadamente rejeitadas ou especializadas

- Não exigir que toda slice atravesse schema, API, UI e testes. Ela toca somente as boundaries
  necessárias ao resultado real do projeto.
- Não impor linguagem, framework, test runner, cloud, banco, diretório, comando, TDD, commit por
  task ou duração fixa. Tudo isso vem da fonte do projeto ou de decisão explícita.
- Não aceitar fases horizontais de “contrato”, “backend”, “frontend” e “integrar depois” quando a
  fase isolada não é consumível. Paralelismo por contrato só é usado quando o contrato já é estável,
  cada ramo possui prova própria e a integração está planejada.
- Não exigir critério inventado nem comando presumido pela aparência do stack. `change-only`,
  artifact útil e receipt bounded são alternativas honestas com semântica de prova limitada.
- Não publicar issues, iniciar execução, escolher provider/modelo ou pedir ao executor que complete
  o plano. A saída da skill é somente o graph Markdown humano e parser-compatible.
- Não confiar em números universais como “2–5 minutos”, “cinco arquivos” ou “100 linhas”. O limite
  correto é o que cabe numa tentativa/revisão curta e preserva um resultado verificável.

## Regra de refresh

Ao atualizar esta curadoria, conferir os arquivos e licenças nos repositórios originais, registrar a
data da releitura e reavaliar cada ideia contra os invariantes do Ralph. Nunca importar mudanças
upstream automaticamente nem substituir o parser/schema oficial por convenções de outra skill.
