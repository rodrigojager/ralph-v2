# Contrato da skill `ralph-loop-prd-generator`

Este diretório define a interface normativa consumida pela skill que transforma um projeto, cenário,
especificação ou PRD de alto nível em PRD v2 verticalizado. O pacote distributável vive em
[`skills/ralph-loop-prd-generator`](../../skills/ralph-loop-prd-generator/): seu `SKILL.md`, suas
referências e seus assets curam este contrato sem criar uma segunda autoridade de parsing. O
validator da versão instalada do Ralph continua sendo a autoridade final.

## Separação entre implementação e produto

O `/goal` do Codex é apenas o mecanismo usado agora para implementar o código do Ralph v2. Ele não faz parte da arquitetura do produto, não será requisito de execução e não governa runs futuras.

O fluxo do produto é independente:

```text
projeto, cenário ou PRD de origem
                │
                ▼
skill ralph-loop-prd-generator
  escreve root + todos os children
                │
                ▼
ralph prd validate --recursive --strict
                │
                ▼
Ralph CLI independente compila, executa e atualiza markers
```

A skill é a única autora do root PRD e de todos os sub-PRDs. A autoria termina antes de `run`, `loop`, `wiggum`, `once` ou `parallel`. O runtime apenas detecta formato, compila, valida, inspeciona, migra quando comandado, executa o graph já existente e altera markers autorizados. Child ausente ou inválido é erro anterior a qualquer chamada de modelo; o runtime nunca pede ao executor para criar, completar ou reorganizar o plano.

## Fontes normativas

A skill distribuível deve consumir, nesta ordem:

1. [`schemas/prd-document.schema.json`](../../schemas/prd-document.schema.json) e [`schemas/compiled-prd-graph.schema.json`](../../schemas/compiled-prd-graph.schema.json), gerados dos validators runtime;
2. [vocabulário canônico](vocabulary.md), que documenta a representação Markdown desses schemas;
3. [template PRD v2](PRD-v2.template.md), que é um documento standalone estruturalmente válido;
4. `ralph prd validate`, que é a autoridade final sobre a saída concreta.

Schema, parser, formatter, exemplos e skill não podem manter gramáticas independentes. Se este contrato divergir do validator da mesma versão, a skill deve parar e relatar incompatibilidade em vez de adivinhar uma correção.

## Entradas

A skill recebe uma ou mais fontes de verdade:

- projeto/repositório existente;
- especificação, PRD, issue, cenário ou conversa;
- restrições fornecidas pelo usuário;
- contratos e comandos já existentes no projeto;
- requisitos de rollout, infraestrutura, segurança, observabilidade e compatibilidade que façam parte da entrega.

Linguagem, framework, banco, cloud, provider de IA, test runner e ferramentas do projeto são entradas, nunca defaults da skill. A skill preserva o stack encontrado ou explicitamente escolhido; ela não substitui tecnologias para adequar o projeto a exemplos do Ralph.

## Saídas obrigatórias

A geração produz, antes do run:

- um PRD `kind: root`;
- cada PRD `kind: child` referenciado, já existente no path declarado;
- IDs estáveis, dependencies por task ID e grupos paralelos somente quando justificados;
- resultado observável, limites e modo de evidência de cada slice;
- critérios reais quando existirem;
- verificações estruturadas ou instruções honestas baseadas no projeto;
- artifact path explícito quando o evidence mode exigir artifact;
- defaults e budgets somente quando sustentados pela origem ou pelo usuário;
- contexto Markdown compartilhado enxuto antes de `## Vertical slices`, para reconstrução determinística por `sharedContext`;
- categoria/skip policy de command somente pelo wrapper estruturado quando forem sustentadas pela fonte, nunca por inferência do executable;
- resumo humano de documentos, slices, dependencies e decisões de último recurso.

A skill não executa a implementação do projeto, não marca `[~]`/`[x]`, não inicia Ralph, não configura provider/judge por preferência própria e não cria critério apenas para satisfazer o schema.
O contrato de conclusão da task também não muda com o avaliador: deterministic-only, self-review e
judge externo consomem a mesma descrição, critérios e evidências. “O judge aprova” não é critério, e
um profile de judge só entra no PRD quando a fonte ou o usuário o escolheu explicitamente.

## Curadoria externa

O pacote distribuível registra em
[`references/curation.md`](../../skills/ralph-loop-prd-generator/references/curation.md) as skills
públicas consultadas, ideias adotadas, especializações/rejeições e regra de refresh. A síntese não
copia templates ou gramáticas externas: o parser PRD v2 continua sendo a única autoridade, e
exemplos de stack, TDD, commits, paths e duração das fontes não viram defaults do Ralph.

## Workflow de autoria

1. **Estabelecer a fonte de verdade.** Inspecionar somente o necessário para confirmar comportamento, arquitetura, contratos, comandos e restrições existentes.
2. **Mapear capacidades.** Para cada incremento, identificar ator/caller, gatilho, resultado observável, falhas relevantes, boundaries necessárias e melhor prova viável.
3. **Cortar verticalmente.** Manter na mesma task toda integração necessária ao comportamento, sem criar fases horizontais de backend, frontend, infraestrutura e testes.
4. **Dimensionar o contexto.** Dividir quando houver resultados independentes ou trabalho excessivo para um contexto limpo; criar child somente quando o detalhamento adicional for necessário.
5. **Definir evidência.** Preferir critérios e verificações determinísticas reais; usar `change-only`
   ou artifact útil quando não houver oracle semântico melhor e, como fallback final, pré-declarar
   um receipt bounded ligado à task quando nenhum outro entregável material puder ser definido.
   Manter esse mesmo contrato utilizável por deterministic-only, self-review ou judge externo; a
   avaliação configurada interpreta a prova, mas não redefine a task.
6. **Escrever todos os arquivos.** Resolver `parent`, paths, IDs e dependencies antes de qualquer run.
7. **Validar recursivamente.** Executar o comando oficial em strict mode e corrigir todos os diagnostics.
8. **Inspecionar identidades derivadas.** Confirmar pelo `prd inspect` que root/children possuem `definitionHash`, cada task/ref possui `taskSpecHash` e commands explicitamente classificadas preservam category/skip policy.
9. **Revisar como humano.** Confirmar que resultado, ordem, pronto e limites continuam compreensíveis abrindo apenas os Markdown.
10. **Entregar o plano.** Emitir resumo sem modificar status e sem iniciar execução salvo pedido separado e posterior.

## Regra de vertical slice

Uma task válida entrega uma capacidade pequena de ponta a ponta pelas boundaries realmente necessárias. Implementação, integração e prova pertencem à mesma slice. Uma task não precisa tocar toda camada por ritual, mas não pode deixar “conectar depois” para outra tarefa sem valor independente.

Fundação, refatoração ou infraestrutura pura só é uma task final quando possui consumidor/resultado operacional verificável ou artifact durável que seja ele próprio o entregável. Mudanças amplas devem preferir expandir, migrar consumidores em incrementos verdes e então contrair a forma antiga.

## Evidência sem critério artificial

Aplicar a seguinte ordem:

1. `criteria`: condições falsificáveis e verificações existentes de verdade;
2. `change-only`: diff permitido não vazio quando isso é o melhor sinal proporcional disponível;
3. `artifact`: arquivo útil, previamente nomeado e verificável por path/hash/schema;
4. `criteria+artifact` ou `change+artifact` quando ambas as provas são necessárias.

Uma instrução humana em `Verificação` é válida quando não existe comando estruturado autoritativo. Ela não é convertida em shell nem tratada automaticamente como sucesso. Um artifact prova materialização auditável, não correção semântica por si só.

Se nenhum entregável natural sobreviver a essa ordem, a skill declara antes do run um receipt de
conclusão não vazio, em path relativo ligado ao task ID. O arquivo registra task, resultado buscado,
ação realizada, arquivos/efeitos observados e limitações. O diff/hash desse receipt é uma prova
determinística mínima de materialização, exatamente para não depender apenas da palavra do executor;
não é uma afirmação de correção semântica. O runtime não escolhe esse arquivo depois do fato.

## Validação obrigatória

Depois de escrever root e children:

```text
ralph prd validate <root-prd> --recursive --strict
```

Para diagnosticar a representação compilada:

```text
ralph prd inspect <root-prd> --recursive --strict --format json
```

A skill deve corrigir diagnostics de schema, aliases, estrutura CommonMark, IDs, paths, dependencies, cycles, parent mismatch, evidence mode, artifact e budget. Ela nunca contorna erro removendo child, critério ou limite necessário sem retornar à fonte de verdade.

## Compatibilidade v1

PRD clássico é entrada possível da skill, não formato de saída recomendado. A conversão automática do CLI usa `prd migrate`, grava destino separado por default e gera relatório de inferências/perdas. A skill pode então reescrever slices fracas com contexto humano, mas não deve esconder os conflitos de `[~]` ou de `depends_on` descritos no [vocabulário](vocabulary.md#compatibilidade-com-prd-v1).

## Empacotamento

O pacote S12 contém `SKILL.md` conciso, metadata de interface, referências de carregamento sob
demanda e templates root/child. Ele instrui a geração completa antes do run, mantém ferramentas e
linguagens como entradas, usa evidence modes honestos e exige o validator oficial. As referências
distribuídas documentam a representação Markdown da mesma versão, mas não substituem schemas ou
diagnostics do CLI. Este README permanece documentação de integração do repositório e não é
incluído como arquivo auxiliar dentro da skill instalada.

No fechamento local de 2026-07-19, o pacote passou no `quick_validate.py` da infraestrutura de
skills (Python em modo UTF-8 explícito). O standalone Windows x64 validou e inspecionou
recursivamente `examples/vertical-notes/PRD.md`: 2 documentos, 5 vertical slices, parent/child edge,
dependency edges, hashes derivados e zero diagnostics. Essa prova confirma estrutura da skill e
compatibilidade do sample com o parser atual; não substitui o forward test independente de geração,
a execução do sample, a matriz multiplataforma nem a validação do pacote final de release.
