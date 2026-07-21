# Vocabulário canônico do PRD v2

Este documento descreve como a skill distribuível materializa o schema do compilador em Markdown
humano. O parser usa CommonMark AST para descobrir estrutura e regex somente para tokens folha.
Labels desconhecidos, duplicados ou ambíguos são erro; prose livre nunca é interpretada por uma LLM
durante a compilação.

## Documento

O arquivo começa com YAML frontmatter seguro:

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

| Campo | Contrato |
| --- | --- |
| `ralph_prd` | inteiro `2`; sua presença seleciona v2 e valor inválido nunca faz fallback para v1 |
| `id` | slug estável, único no graph |
| `title` | nome humano não vazio |
| `kind` | `root` ou `child` |
| `parent` | obrigatório somente em child, com `prd` e `task` |
| `workspace` | path relativo normalizado; `.` é permitido |
| `defaults` | objeto estrito de profiles, evidence mode e budget herdáveis |
| `metadata` | extensões namespaced e sem segredos; não controla comportamento core desconhecido |

Um child declara:

```yaml
kind: child
parent:
  prd: ../PRD.md
  task: parent-task-id
```

Todos os paths são relativos. Referências child podem usar `..` para chegar ao documento pai, mas a resolução canônica e a policy de workspace ainda precisam ser válidas.

Todo Markdown entre o fim do frontmatter e o heading normativo é preservado pelo compilador como `sharedContext` (`markdown`, texto normalizado e AST sanitizada). A skill deve colocar ali somente contexto compartilhado útil às tasks; um documento sem prose compartilhada continua válido e compila contexto vazio. `definitionHash` e `taskSpecHash` são campos derivados pelo compilador, não chaves que a skill escreve no Markdown.

## Seção normativa e header de task

Existe exatamente um heading nível 2 com esta grafia:

```markdown
## Vertical slices
```

Seu conteúdo é exatamente uma lista não ordenada de primeiro nível. Cada item começa com:

```markdown
- [ ] **task-id — Título humano**
```

Regras:

- `[ ]` = pending;
- `[~]` = active no PRD v2;
- `[x]` = completed;
- o título inteiro fica em um único `strong`;
- o formatter canônico escreve travessão `—`;
- IDs seguem `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`;
- ordem textual desempata tasks elegíveis, mas dependency é sempre explícita por task ID.

## Labels de task

Cada label é um item filho direto da task.

| Canônico PT | Alias EN aceito | Cardinalidade e forma |
| --- | --- | --- |
| `Resultado` | `Result` | obrigatório; exatamente um conteúdo Markdown não vazio |
| `Dependências` | `Dependencies` | obrigatório; valor inline com IDs separados por vírgula ou `nenhuma`/`none` |
| `Critérios` | `Criteria` | lista ordenada ou não ordenada; exigida quando o mode contém `criteria` |
| `Verificação` | `Verification` | lista de instructions/specs; pode ser omitida quando a policy permitir |
| `Limites` | `Boundaries` | obrigatório; ao menos um item explícito |
| `Modo de evidência` | `Evidence mode` | valor inline ou default herdado |
| `Sub-PRD` | `Sub-PRD` | obrigatório; path relativo ou `nenhum`/`none` |
| `Grupo paralelo` | `Parallel group` | opcional; slug |
| `Perfis` | `Profiles` | opcional; assignments `executor=` e/ou `judge=` |
| `Orçamento` | `Budget` | opcional; assignments tipados |
| `Notas` | `Notes` | opcional; lista Markdown sem semântica de execução oculta |

O arquivo canônico usa os labels PT acima. O parser aceita apenas os aliases declarados; não traduz nem adivinha sinônimos.

`nenhum`, `nenhuma` e `none` são ausência explícita. Campo omitido e ausência explícita não são equivalentes quando o label é obrigatório.

## Modos de evidência

Valores fechados:

- `criteria`;
- `change-only`;
- `artifact`;
- `criteria+artifact`;
- `change+artifact`.

Modes com `criteria` exigem ao menos um critério real e um gate determinístico capaz de produzir
evidence; `instruction` nunca conta. Modes com `artifact` exigem uma verificação
`artifact` com ID e path explícitos, salvo quando a task referencia um child previamente gerado que
materializa o contrato correspondente. Uma folha `file:` isolada não satisfaz esse requisito do
parser. `change-only` não autoriza a skill a inventar critérios superficiais.

## Verificação

Cada entrada é discriminada por um prefixo folha. Texto sem prefixo é tratado como `instruction` para preservar procedimentos humanos existentes.

### Instruction

```markdown
- Verificação:
  - instruction: Executar o cenário de maior nível disponível e registrar o resultado.
```

`instruction` preserva Markdown/texto no objeto compilado e orienta o executor, mas possui contrato
fixo `category: instruction`, `skipPolicy: never-run` e `blocking: false`. Ela não aceita metadata de
execução ou `criterionIds`, não entra no plano/registry/contadores da pipeline normal e nunca satisfaz
`criteria`. Sem gate real, a skill deve escolher `change-only` ou `artifact`, não promover a instrução.

### Command

```markdown
- Verificação:
  - command: {"executable":"project-check","args":["--scope","this-slice"],"shell":false,"timeoutMs":120000,"successExitCodes":[0],"outputLimitBytes":1048576}
```

O conteúdo após `command:` é um objeto JSON `CommandSpec`, nunca uma string de shell. Campos:

| Campo | Regra |
| --- | --- |
| `executable` | executable explícito não vazio |
| `args` | array de argumentos, preservando boundaries |
| `cwd` | path relativo opcional |
| `environmentRefs` | refs de ambiente, nunca secrets literais |
| `shell` | ausente/`false` ou objeto `{kind, executable?}` |
| `timeoutMs` | inteiro positivo |
| `successExitCodes` | array não vazio de inteiros |
| `outputLimitBytes` | inteiro positivo |

`shell.kind` é `powershell`, `cmd`, `sh`, `bash` ou `custom`. Mesmo com shell explícito, script/args continuam campos estruturados submetidos à policy; a skill não concatena input não confiável. O exemplo é apenas shape: `executable` e args devem vir do projeto ou do usuário.

A forma direta acima é compatível e compila sem heurística como `category: command`, `skipPolicy: required`, `blocking: true`. Para classificar um command ou permitir skip, a skill usa o wrapper explícito:

```markdown
- Verificação:
  - command: {"category":"test","skipPolicy":"allowed-to-skip","blocking":true,"command":{"executable":"project-check","args":["--scope","this-slice"],"shell":false,"timeoutMs":120000,"successExitCodes":[0],"outputLimitBytes":1048576}}
```

Categorias de command aceitas: `command`, `test`, `lint`, `typecheck`, `build`, `security`. Skip policies aceitas: `required`, `optional`, `allowed-to-skip`, `never-run`. `optional` e `never-run` exigem `blocking: false`. A skill não classifica por nome de executable, comando em prose ou convenção de stack; se a fonte não sustenta a metadata, conserva a forma direta required.

### File

```markdown
- Verificação:
  - file: relative/path.json; non-empty
```

Expectations aceitas:

- `exists`;
- `non-empty`;
- `absent`;
- `sha256=<64-hex>`;
- `schema=<relative-schema-path>`.

### Artifact

```markdown
- Verificação:
  - artifact: decision-record; path=artifacts/decision-record.md
  - artifact: evidence-index; path=artifacts/evidence.json; schema=schemas/evidence.schema.json
```

Artifact ID é slug e `path` relativo é obrigatório. `schema` relativo é opcional. Um artifact é planejado pela skill antes do run; o runtime nunca escolhe um arquivo arbitrário depois da tentativa. Existência prova materialização, não verdade semântica além das expectations declaradas.

Como último recurso, quando a tarefa não possui outro entregável material honesto, o artifact pode
ser um receipt de conclusão ligado à task e previamente nomeado. Ele precisa ser não vazio e
registrar task ID, resultado buscado, ação realizada, arquivos/efeitos observados e limitações. O
receipt existe para produzir evidência determinística mínima por diff/hash; não transforma a palavra
do executor em prova semântica e não pode ser escolhido apenas depois da tentativa.

O receipt usa a mesma forma `artifact: <id>; path=<path>` e um evidence mode que contenha
`artifact`; seu conteúdo mínimo é parte da descrição/critério de materialização da task, não uma
convenção inventada pelo runtime.

### Plugin

```markdown
- Verificação:
  - plugin: organization-check; {"policy":"declared-policy"}
```

Plugin ID é slug e input é JSON. A skill só emite plugin registrado/configurado pela fonte de verdade.

## Defaults

Campos opcionais no frontmatter:

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

Esses valores ilustram shape, não defaults recomendados. A skill omite qualquer limite/profile que não venha do usuário, projeto ou policy selecionada.

Defaults são herdados do parent pelo child e então sobrescritos pelo próprio documento; budget faz merge por chave. O compilador materializa o resultado efetivo no graph. Overrides da task ficam explícitos no Markdown.

## Profiles e budget por task

```markdown
- Perfis: executor=selected-executor; judge=selected-judge
- Orçamento: model_calls=3; tool_calls=40; input_tokens=50000; output_tokens=10000; reasoning_tokens=10000; tokens=70000; cost=2.50 USD; timeout=20m; revisions=2
```

Aliases de budget aceitos pelo parser incluem:

- `model_calls`, `max_model_calls`, `chamadas_modelo`;
- `tool_calls`, `max_tool_calls`, `chamadas_ferramenta`;
- `input_tokens`, `output_tokens`, `reasoning_tokens`;
- `tokens`, `max_tokens`, `total_tokens`;
- `cost`, `custo`, `max_cost`;
- `time`, `tempo`, `timeout`;
- `revisions`, `revisões`, `max_revisions`.

Durations usam número não negativo seguido de `ms`, `s`, `m`, `h` ou `d`; task timeout deve ser maior que zero. Currency usa código ISO de três letras. Contadores zero são válidos quando significam proibição explícita.

## Paths e conteúdo Markdown

- Persistir `/`, mesmo em Windows; o compiler normaliza `\` para `/`.
- Paths absolutos, UNC, drive letters, NUL e escapes não autorizados são erro.
- Resultado, critérios, limites, instructions e notas preservam Markdown sanitizado/AST e texto normalizado; conteúdo não é executado.
- HTML/Markdown vindo do PRD é conteúdo não confiável para apresentação.

## Source map

O CommonMark parser fornece line/column/offset em caracteres para análise interna. O contrato público converte `offset` para bytes UTF-8 desde o início do arquivo; line e column são 1-based. O marker ocupa exatamente três bytes ASCII (`[ ]`, `[~]` ou `[x]`).

O editor usa content hash + byte offset, troca somente o byte central, grava atomicamente e recompila. Offset nunca é tratado como índice UTF-16/JavaScript, especialmente em arquivos com Unicode antes da task.

## Compatibilidade com PRD v1

Detecção:

- `ralph_prd: 2` inteiro seleciona v2;
- presença de `ralph_prd` com outro valor é erro, nunca fallback permissivo;
- sem versão, frontmatter/checklist clássico reconhecido seleciona o adapter v1;
- heading `## Vertical slices` sozinho não transforma um documento clássico em v2.

Conflitos obrigatoriamente reportados:

1. No v1, `[~]` significa `skipped-for-review` e é resolvido; no v2 significa `active`. Migração não copia o marker silenciosamente: materializa pending/revisão humana conforme policy e registra mudança semântica.
2. No parallel v1, `depends_on` referencia grupos; no v2, `Dependências` referencia task IDs. Grupo singleton pode virar dependency direta. Grupo com vários predecessores exige expansão conservadora e notice; referência ausente/ambígua falha em strict.

`prd migrate` grava outro arquivo por default, recusa sobrescrita sem autorização e emite relatório versionado de mappings `direct`, `inferred`, `promoted`, `dropped` e `semantic-change`. Strings legadas de command/gate são preservadas apenas como instructions não executáveis, portanto a migração usa `change-only` mesmo quando conserva acceptance criteria; a autora precisa declarar gates v2 reais antes de escolher `criteria`. Ausência de critério nunca é preenchida artificialmente.

## Validação

Contrato final de geração:

```text
ralph prd validate <root-prd> --recursive --strict
ralph prd inspect <root-prd> --recursive --strict --format json
```

A validação recursiva deve terminar sem erro antes de entregar o plano ou iniciar qualquer run.
