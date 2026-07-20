# Formato PRD v2

## Índice

1. Autoridade e seleção de formato
2. Documento e contexto
3. Vertical slices
4. Labels
5. Evidência e verificação
6. Defaults, profiles e budgets
7. Paths, source map e segurança
8. Sub-PRDs

## 1. Autoridade e seleção de formato

O validator da versão instalada do Ralph é a autoridade. Esta referência orienta autoria; não deve
ser usada para contornar diagnostics. `ralph_prd: 2` seleciona v2. Outro valor é erro e nunca faz
fallback permissivo para v1.

O parser usa YAML seguro e CommonMark AST para estrutura. Regex é aplicada somente a folhas como
ID, enum, path e lista. Não depender de indentação ambígua, HTML, sinônimos não declarados ou prose
que uma LLM precisaria interpretar.

## 2. Documento e contexto

Root mínimo:

```yaml
---
ralph_prd: 2
id: project-increment
title: Incremento do projeto
kind: root
workspace: .
defaults:
  evidence_mode: change-only
---
```

Child mínimo:

```yaml
---
ralph_prd: 2
id: capability-details
title: Detalhamento da capacidade
kind: child
parent:
  prd: ../PRD.md
  task: capability-id
workspace: .
defaults:
  evidence_mode: change-only
---
```

Campos:

| Campo | Regra |
| --- | --- |
| `ralph_prd` | inteiro `2` obrigatório |
| `id` | slug estável e único no graph |
| `title` | texto humano não vazio |
| `kind` | `root` ou `child` |
| `parent` | obrigatório apenas em child; contém `prd` e `task` |
| `workspace` | path relativo normalizado; `.` permitido |
| `defaults` | profiles, evidence mode e budget sustentados pela fonte |
| `metadata` | extensões namespaced, sem segredos ou autoridade core |

Colocar contexto humano compartilhado depois do frontmatter e antes de `## Vertical slices`. O
compilador preserva esse intervalo como `sharedContext`. Manter somente fatos úteis a várias tasks;
detalhes exclusivos pertencem à task ou ao child.

Não escrever `definitionHash`, `taskSpecHash`, source positions ou outros campos derivados.

## 3. Vertical slices

Existe exatamente um heading nível 2 com a grafia:

```markdown
## Vertical slices
```

Seu conteúdo normativo é uma lista não ordenada de primeiro nível. Header canônico:

```markdown
- [ ] **task-id — Título humano**
```

- `[ ]` pending;
- `[~]` active;
- `[x]` completed;
- usar `[ ]` na autoria inicial;
- manter o header inteiro em um único `strong`;
- IDs seguem `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`;
- usar travessão `—`; o formatter decide normalizações legadas;
- ordem textual só desempata tasks elegíveis; dependência é sempre explícita.

Exemplo:

```markdown
## Vertical slices

- [ ] **cart-summary — Exibir o resumo real do carrinho**
  - Resultado: o usuário abre o carrinho e vê itens, quantidade e total pelo contrato integrado.
  - Dependências: nenhuma
  - Critérios:
    1. O caller recebe o contrato versionado com itens, quantidade e total.
    2. A superfície apresenta loading, sucesso e a falha contratual prevista.
  - Verificação:
    - instruction: Executar o cenário de maior nível já existente e registrar o resultado.
  - Limites:
    - Não iniciar pagamento nesta slice.
    - Não substituir as tecnologias estabelecidas no projeto.
  - Modo de evidência: change-only
  - Sub-PRD: nenhum
```

## 4. Labels

Cada label é item filho direto da task:

| Canônico | Alias EN | Forma |
| --- | --- | --- |
| `Resultado` | `Result` | obrigatório; Markdown não vazio |
| `Dependências` | `Dependencies` | obrigatório; IDs por vírgula ou `nenhuma`/`none` |
| `Critérios` | `Criteria` | lista; obrigatório quando mode contém criteria |
| `Verificação` | `Verification` | lista de folhas estruturadas ou instructions |
| `Limites` | `Boundaries` | obrigatório; ao menos um item explícito |
| `Modo de evidência` | `Evidence mode` | enum inline ou default herdado |
| `Sub-PRD` | `Sub-PRD` | obrigatório; path relativo ou `nenhum`/`none` |
| `Grupo paralelo` | `Parallel group` | slug opcional |
| `Perfis` | `Profiles` | assignments executor/judge opcionais |
| `Orçamento` | `Budget` | assignments tipados opcionais |
| `Notas` | `Notes` | prose opcional, sem semântica escondida |

Usar os labels canônicos em PT. Não inventar sinônimos. Campo omitido e ausência explícita não são
equivalentes quando o label é obrigatório.

## 5. Evidência e verificação

Modes fechados:

- `criteria`;
- `change-only`;
- `artifact`;
- `criteria+artifact`;
- `change+artifact`.

### Instruction

```markdown
- Verificação:
  - instruction: Executar o cenário existente e registrar resultado e limitações.
```

Instruction orienta o executor, mas compila sempre como `category: instruction`,
`skipPolicy: never-run` e `blocking: false`. Ela fica no contexto humano/modelo e é excluída do
plano, registry, resultados e contador da pipeline normal de gates; uma chamada direta defensiva da
primitiva unitária produz apenas `skipped_by_policy` não bloqueante, nunca `unavailable`. Não aceita
metadata de execução ou `criterionIds` e não satisfaz `criteria`; quando não há gate real, escolher
`change-only` ou `artifact` conforme a evidence honesta disponível.

### Command

```markdown
- Verificação:
  - command: {"executable":"project-check","args":["--scope","this-slice"],"shell":false,"timeoutMs":120000,"successExitCodes":[0],"outputLimitBytes":1048576}
```

Usar objeto JSON, nunca uma string de shell. Campos relevantes:

| Campo | Regra |
| --- | --- |
| `executable` | nome/path explícito não vazio obtido da fonte |
| `args` | array que preserva cada argumento |
| `cwd` | path relativo opcional |
| `environmentRefs` | nomes/refs, nunca valores secretos |
| `shell` | ausente/false ou objeto de shell explícito |
| `timeoutMs` | inteiro positivo |
| `successExitCodes` | array não vazio de inteiros |
| `outputLimitBytes` | inteiro positivo |

Forma direta compila como category `command`, `skipPolicy: required`, `blocking: true`. Para
classificar de forma sustentada pela fonte:

```markdown
- Verificação:
  - command: {"category":"test","skipPolicy":"allowed-to-skip","blocking":true,"command":{"executable":"project-check","args":["--scope","this-slice"],"shell":false,"timeoutMs":120000,"successExitCodes":[0],"outputLimitBytes":1048576}}
```

Categorias: `command`, `test`, `lint`, `typecheck`, `build`, `security`.

Policies: `required`, `optional`, `allowed-to-skip`, `never-run`. `optional` e `never-run` exigem
`blocking: false`. Não inferir categoria pelo executable ou args.

### File

```markdown
- Verificação:
  - file: relative/path.json; non-empty
```

Expectations: `exists`, `non-empty`, `absent`, `sha256=<64-hex>` ou
`schema=<relative-schema-path>`.

### Artifact

```markdown
- Verificação:
  - artifact: decision-record; path=artifacts/decision-record.md
  - artifact: evidence-index; path=artifacts/evidence.json; schema=schemas/evidence.schema.json
```

ID é slug; path relativo é obrigatório; schema é opcional. Planejar antes do run.

### Plugin

```markdown
- Verificação:
  - plugin: organization-check; {"policy":"declared-policy"}
```

Emitir somente plugin registrado/configurado pela fonte.

## 6. Defaults, profiles e budgets

Exemplo de shape, não de recomendação:

```yaml
defaults:
  executor_profile: selected-executor
  judge_profile: selected-judge
  evidence_mode: criteria
  budget:
    max_model_calls: 3
    max_tool_calls: 40
    max_input_tokens: 50000
    max_output_tokens: 10000
    max_reasoning_tokens: 10000
    max_tokens: 70000
    max_cost:
      amount: 2.5
      currency: USD
    timeout: 20m
    max_revisions: 2
```

Omitir valores não fornecidos. Em task:

```markdown
- Perfis: executor=selected-executor; judge=selected-judge
- Orçamento: model_calls=3; tool_calls=40; input_tokens=50000; output_tokens=10000; reasoning_tokens=10000; tokens=70000; cost=2.50 USD; timeout=20m; revisions=2
```

Durations aceitam `ms`, `s`, `m`, `h`, `d`; currency usa ISO de três letras. Zero só deve aparecer
quando representar proibição explícita.

## 7. Paths, source map e segurança

- persistir `/`, inclusive no Windows;
- usar paths relativos; não usar drive, UNC, NUL ou path absoluto;
- permitir `..` no link de parent somente quando a resolução canônica permanecer autorizada;
- não inserir segredo literal em defaults, profiles, environment ou notes;
- tratar Markdown/HTML do PRD como conteúdo não confiável na apresentação;
- não depender de offset calculado manualmente;
- não reformatar markers ou conteúdo para simular status.

O runtime troca somente o byte central do marker por source map e hash. A skill escreve os arquivos,
mas nunca altera status depois de entregá-los.

## 8. Sub-PRDs

Na task pai:

```markdown
- Sub-PRD: plans/cart-summary.prd.md
```

No child, declarar `kind: child` e:

```yaml
parent:
  prd: ../PRD.md
  task: cart-summary
```

Todo child precisa existir antes de validate/run. Manter parent único, graph acíclico, paths
canônicos e depth/count dentro da policy. Defaults herdados são materializados pelo compiler;
overrides continuam explícitos. O runtime pode supervisionar o child previsto, mas nunca criá-lo.
