---
name: ralph-loop-prd-generator
description: Create or rewrite Ralph Loop CLI v2 root PRDs and pre-authored Sub-PRDs as small vertical slices from a repository, product brief, issue, scenario, or legacy PRD. Use when Codex must plan end-to-end increments across the necessary frontend, backend, data, infrastructure, security, observability, documentation, or rollout boundaries while preserving the project's chosen stack; produce deterministic parser-compatible Markdown, honest evidence modes, dependencies and parallel groups, and validate the complete graph before handoff.
---

# Gerar PRD verticalizado para Ralph

Transformar a fonte fornecida em um plano legível por humanos e compilável pelo Ralph v2. Escrever
o root e todos os children antes de qualquer execução. Não implementar o projeto, iniciar um run,
marcar tarefas ou escolher tecnologias que a fonte não escolheu.

## Carregar referências sob demanda

- Ler [references/vertical-slices.md](references/vertical-slices.md) antes de decompor capacidades.
- Ler [references/prd-v2-format.md](references/prd-v2-format.md) antes de escrever Markdown.
- Ler [references/final-review.md](references/final-review.md) antes de validar e entregar.
- Ler [references/curation.md](references/curation.md) somente ao explicar a origem das decisões ou
  atualizar a própria skill; ela não é necessária para gerar um PRD comum.
- Usar [assets/root-prd.template.md](assets/root-prd.template.md) e
  [assets/child-prd.template.md](assets/child-prd.template.md) como scaffolds, nunca como requisitos
  de produto ou defaults tecnológicos.

## Workflow

1. **Fixar as fontes de verdade.** Identificar pedido, restrições, repositório, contratos, decisões,
   PRD legado e comportamento já existente. Distinguir fato confirmado, inferência e pergunta em
   aberto. Não preencher lacunas escolhendo stack por preferência.
2. **Inspecionar somente o necessário.** Confirmar entrypoints, boundaries, contratos, comandos de
   verificação, convenções e riscos relevantes. Preservar linguagem, framework, banco, cloud,
   provider, test runner e ferramentas encontrados ou explicitamente escolhidos.
3. **Mapear capacidades observáveis.** Para cada incremento, registrar ator ou caller, gatilho,
   resultado observável, falhas importantes, boundaries necessárias, rollout e melhor evidência
   disponível.
4. **Cortar verticalmente.** Manter na mesma tarefa implementação, integração e prova necessárias
   para entregar uma capacidade pequena de ponta a ponta. Não criar fases finais por camada como
   “todo backend”, “todo frontend”, “infra depois” ou “conectar depois”.
5. **Dimensionar o contexto.** Dividir quando houver resultados independentes ou contexto grande
   demais para uma tentativa curta. Criar Sub-PRD somente quando uma tarefa pai precisar de várias
   slices internas coerentes; gerar esse arquivo imediatamente e referenciá-lo explicitamente.
6. **Ordenar e paralelizar.** Declarar apenas dependências reais por task ID. Usar grupo paralelo
   somente quando as tarefas puderem avançar sem contrato ainda indefinido, arquivo compartilhado
   perigoso ou dependência implícita. Manter a integração do grupo explícita no plano.
7. **Escolher evidência honesta.** Preferir critérios falsificáveis e verificações já existentes.
   Usar `criteria` somente quando houver gate determinístico real capaz de produzir evidence; uma
   `instruction` orienta o executor, mas é sempre `never-run`, não bloqueante e não satisfaz critério.
   Quando não houver oracle semântico proporcional, usar `change-only` ou um artifact útil,
   previamente nomeado. Nunca inventar teste, comando ou critério superficial para satisfazer o
   schema. Artifact prova materialização, não correção semântica. Definir o contrato de conclusão
   independentemente de quem o avaliará: deterministic-only, self-review e judge externo consomem
   a mesma task, critérios e evidências. Não usar “o judge aprova” como critério nem tornar um
   perfil de judge obrigatório se a fonte não o escolheu.
8. **Escrever o graph completo.** Criar o root e todos os children com IDs estáveis, parents,
   paths, dependencies, limites, evidence modes, verificações e budgets sustentados pela fonte.
   Nunca delegar ao runtime ou executor a criação tardia de Sub-PRD.
9. **Validar pela autoridade oficial.** Executar, salvo proibição explícita do usuário:

   ```text
   ralph prd validate <root-prd> --recursive --strict
   ralph prd inspect <root-prd> --recursive --strict --format json
   ```

   Corrigir todos os diagnostics e confirmar identities/child edges. Se o binário não estiver
   disponível ou a execução estiver proibida, não afirmar validade: entregar com estado
   `validação executável pendente` e fornecer os comandos exatos.
10. **Revisar como humano.** Abrir cada Markdown e confirmar que objetivo, ordem, limites, pronto e
    relações pai/filho são compreensíveis sem consultar JSON ou código do parser.
11. **Entregar sem executar.** Resumir arquivos criados, slices, children, dependencies, grupos,
    decisões de evidência e validação realizada ou pendente. Não iniciar Ralph sem pedido separado.

## Invariantes

- Fazer do Ralph o consumidor do plano, nunca seu autor durante runtime.
- Produzir exatamente um root e materializar previamente todo child referenciado.
- Manter cada tarefa pequena, integrada e verificável, sem exigir que todas as camadas sejam
  tocadas por ritual.
- Colocar contrato entre boundaries dentro da mesma slice que o consome.
- Preservar trabalho existente e mudanças do usuário; não reformatar arquivos fora do plano.
- Omitir profiles, budgets e comandos não sustentados pela fonte.
- Representar segredo somente por referência; nunca copiar valores para PRD.
- Usar paths relativos com `/`; não escrever drive, UNC ou path absoluto.
- Manter status inicial `[ ]`, salvo migração explícita com decisão humana documentada.
- Não tratar uma instrução humana como comando executável, gate, vínculo de critério ou aprovação
  automática; instruction pode orientar, mas nunca substitui evidence mode concluível.
- Manter criteria/evidence compatíveis com a mesma avaliação deterministic-only, self ou external;
  quando a natureza da task permitir, o plano continua concluível sem chamada julgadora.

## Regra de último recurso

Aplicar esta ordem sem fingir certeza:

1. `criteria` para condições falsificáveis reais;
2. `change-only` quando um diff permitido não vazio for o melhor sinal proporcional;
3. `artifact` para um arquivo útil, declarado por path e expectativa antes do run;
4. composição `criteria+artifact` ou `change+artifact` quando ambas forem necessárias.

Se nenhuma dessas formas produzir um entregável material definido, ainda assim pré-declarar como
último recurso um **receipt de conclusão bounded** em path relativo ligado ao task ID. O receipt deve
ser criado ou alterado pela tentativa e registrar ao menos task ID, resultado buscado, ação realizada,
arquivos/efeitos observados e limitações. Sua existência e seu hash provam somente que houve uma
entrega material auditável; não provam correção semântica nem substituem judge, gates ou parecer
humano quando configurados.

Preferir sempre um artifact útil — decisão, inventário, diagnóstico, migração, contrato ou relatório
— ao receipt. Não criar arquivo vazio, aleatório ou escolhido depois da execução. Se a fonte proibir
qualquer novo arquivo ou mudança material, registrar a lacuna para decisão humana em vez de fabricar
aprovação textual.
