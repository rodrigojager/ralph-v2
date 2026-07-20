# 07 — PRD v2, sub-PRDs e contrato da skill

## Objetivo duplo

O formato deve continuar agradável para leitura e edição humana, como o PRD clássico, e ao mesmo tempo produzir uma árvore fortemente tipada por parsing determinístico. A solução é Markdown restrito e versionado:

- YAML frontmatter para metadados de documento;
- CommonMark AST para estrutura;
- labels normativos para campos de tarefa;
- JSON Schema/validação tipada para a representação compilada;
- regex somente para tokens folha, nunca para descobrir toda a estrutura;
- edição do checkbox por posição de origem, sem reformatar a descrição humana.

## Autoria versus runtime

A skill distribuível `ralph-loop-prd-generator` é a única responsável por transformar projeto,
cenário ou PRD de alto nível em:

- PRD principal verticalizado;
- todos os sub-PRDs referenciados;
- IDs, dependências e grupos paralelos;
- critérios e verificações existentes de verdade;
- modo de evidência de último recurso quando critérios precisos não fizerem sentido.

O runtime do Ralph:

- lê, compila, valida e executa;
- nunca inventa nem expande sub-PRD;
- nunca pede ao executor para criar planejamento ausente;
- falha antes da execução se uma referência estiver ausente ou inválida;
- pode oferecer `prd inspect`, `prd validate`, `prd format` e `prd migrate`, mas não autoria sem a skill externa.

Essa separação impede que uma execução com contexto curto altere o próprio escopo para facilitar sua aprovação.

## Gramática do documento

Frontmatter mínimo:

```yaml
---
ralph_prd: 2
id: checkout-incremental
title: Checkout incremental
kind: root
workspace: .
defaults:
  executor_profile: default
  evidence_mode: criteria
---
```

Campos:

| Campo | Regra |
| --- | --- |
| `ralph_prd` | inteiro `2`, obrigatório |
| `id` | slug estável, único no graph |
| `title` | texto humano |
| `kind` | `root` ou `child` |
| `parent` | obrigatório em child, com `prd` e `task` |
| `workspace` | caminho relativo ao workspace root |
| `defaults` | perfis e policies herdáveis explicitamente |
| `metadata` | extensões namespaced que o core pode preservar |

O documento possui texto livre de contexto antes da seção normativa. O compilador preserva exatamente esse intervalo como `sharedContext: MarkdownContent` (`markdown`, texto normalizado e AST sanitizada); ausência de prose produz um contexto vazio válido. Conteúdo posterior ao fim da seção normativa continua no arquivo, mas não entra automaticamente no contexto oficial. A fila começa exatamente em um heading nível 2 `## Vertical slices`. Cada tarefa é um item de lista de primeiro nível:

```markdown
- [ ] **checkout-summary — Exibir resumo real do carrinho**
  - Resultado: o usuário vê itens, quantidade e total vindos da API.
  - Dependências: cart-contract
  - Critérios:
    1. `GET /cart` retorna o contrato versionado.
    2. A página renderiza loading, sucesso e erro.
  - Verificação:
    - command: {"executable":"project-check","args":["cart-contract"],"shell":false,"timeoutMs":120000,"successExitCodes":[0],"outputLimitBytes":1048576}
    - command: {"executable":"project-check","args":["cart-summary"],"shell":false,"timeoutMs":120000,"successExitCodes":[0],"outputLimitBytes":1048576}
  - Limites:
    - Não implementar pagamento nesta slice.
  - Modo de evidência: criteria
  - Sub-PRD: nenhum
```

Tokens normativos:

- status: `[ ]` pendente, `[~]` ativa, `[x]` concluída;
- título: strong inline começando com `<task-id> — <título>`; hífen simples pode ser aceito no modo legado, mas o formatter escreve travessão;
- labels: `Resultado`, `Dependências`, `Critérios`, `Verificação`, `Limites`, `Modo de evidência`, `Sub-PRD`, `Grupo paralelo`, `Perfis`, `Orçamento`, `Notas`;
- `nenhuma`/`nenhum` é valor explícito, não campo omitido;
- IDs seguem `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`;
- paths são relativos, normalizados e não podem escapar do workspace/PRD root sem policy explícita.

Labels podem ser localizadas na apresentação futura, mas o arquivo canônico usa um vocabulário de schema fixo. A v2 inicial aceita aliases PT/EN declarados no parser, normalizando para chaves internas; não adivinha labels desconhecidos.

## Campos por tarefa

| Campo | Obrigatoriedade | Semântica |
| --- | --- | --- |
| ID/título/status | obrigatório | identidade e estado materializado |
| Resultado | obrigatório | capacidade observável pequena entregue de ponta a ponta |
| Dependências | obrigatório, pode ser `nenhuma` | IDs que precisam estar concluídos |
| Critérios | conforme evidence mode | condições de produto/contrato verdadeiras |
| Verificação | pode ser vazia sob policy | commands, testes ou inspeções permitidos |
| Limites | obrigatório | o que deliberadamente não entra na slice |
| Modo de evidência | obrigatório após defaults | `criteria`, `change-only`, `artifact` ou composição permitida |
| Sub-PRD | obrigatório, `nenhum` ou path | refinamento pré-gerado |
| Grupo paralelo | opcional | group ID e eventual estratégia de integração |
| Perfis | opcional | override explícito executor/judge |
| Orçamento | opcional | calls, tokens, tempo e revisões |

### Folhas estruturadas de verificação

Bullets de verificação sem prefixo, ou com `instruction:`/`instrução:`, permanecem `instruction` humana. O compilador não transforma prosa nem trechos entre crases em shell. Uma instruction compila invariavelmente como `category: instruction`, `skipPolicy: never-run` e `blocking: false`: ela entra no contexto do executor, mas é excluída do plano, registry, resultados e contador da pipeline normal de gates. Uma chamada direta defensiva da primitiva unitária a normaliza como `skipped_by_policy` não bloqueante, nunca `unavailable`. Ela não pode carregar tentativas, timeout, applicability ou vínculo com critérios e nunca satisfaz um modo `criteria`. As formas estruturadas iniciais são:

- `command: {"executable":"...","args":[],"timeoutMs":300000,"successExitCodes":[0],"outputLimitBytes":1000000}` para um `CommandSpec` completo e sem shell string;
- `file: caminho/relativo; exists|non-empty|absent|sha256=<hash>|schema=<path>`;
- `artifact: artifact-id; path=caminho/relativo[; schema=caminho/do/schema]`;
- `plugin: plugin-id; <JSON input>`.

Esses valores são exemplos de forma, não escolha de linguagem, executável ou ferramenta. A skill deve obter verificações reais do projeto; quando isso não existir, preserva uma instrução honesta e usa `change-only`/`artifact` conforme a evidência disponível, sem inventar comando. `criteria` exige ao menos um gate determinístico capaz de produzir evidence; instruction isolada é rejeitada antes do run.

Toda declaração compilada materializa `category`, `skipPolicy` e `blocking`. Gates executáveis usam a categoria derivada somente de seu tipo, `skipPolicy: required` e o blocking atual; instruction usa sempre o contrato contextual não executável descrito acima. Em particular, uma forma direta `command: <CommandSpec>` sempre vira categoria `command`: o parser nunca tenta deduzir `test`, `lint` ou outra categoria pelo executable, pelos argumentos ou pela prose.

Quando uma command precisa declarar metadata, usa um wrapper JSON explícito e estrito:

```markdown
- Verificação:
  - command: {"category":"test","skipPolicy":"allowed-to-skip","blocking":true,"command":{"executable":"project-check","args":["--slice","current"],"shell":false,"timeoutMs":120000,"successExitCodes":[0],"outputLimitBytes":1048576}}
```

Categorias fechadas de command: `command`, `test`, `lint`, `typecheck`, `build` e `security`. Policies fechadas: `required`, `optional`, `allowed-to-skip` e `never-run`. `optional` e `never-run` exigem `blocking: false`; `allowed-to-skip` roda por default e somente uma flag aplicável pode registrá-la como pulada. `required` não é pulada implicitamente. Gates `file`, `artifact` e `plugin` também materializam policy no objeto tipado; `instruction` conserva o contrato fixo `never-run`/não bloqueante.

`Orçamento` usa pares `key=value` separados por ponto e vírgula ou vírgula. O vocabulário fechado cobre model/tool calls, input/output/reasoning/total tokens, custo com moeda ISO, timeout com unidade `ms|s|m|h|d` e revisões. O objeto compilado mantém contadores separados.

## Vertical slice

Uma tarefa é válida como vertical slice quando:

- entrega uma capacidade observável ou incremento verificável;
- atravessa somente as camadas necessárias — UI, API, domínio, dados, infra, documentação ou observabilidade — sem exigir todas por ritual;
- contém contrato entre camadas dentro da mesma unidade de contexto;
- é pequena o suficiente para uma tentativa/revisão limitada;
- pode ser validada isoladamente ou deixa evidência determinística proporcional;
- explicita limites para impedir expansão horizontal.

São inválidas como tarefa final, salvo fundação indispensável com artifact concreto: “fazer todo o backend”, “criar todas as telas”, “configurar infraestrutura inteira”, “pesquisar solução” sem registro consumível, ou “refatorar camada X” sem comportamento/critério observável.

## Modos de evidência quando o critério é fraco

Não se deve forçar a IA autora a inventar um critério superficial. A ordem é:

1. `criteria`: critérios claros acompanhados de gate determinístico real capaz de produzir evidence;
2. `change-only`: a tarefa é considerada entregável quando existe diff permitido não vazio, mais as políticas mínimas configuradas;
3. `artifact`: um arquivo de prova explicitamente nomeado deve ser criado/alterado e validado por existência/hash/schema;
4. composição, por exemplo `criteria+artifact`.

Um artifact não finge que o conteúdo está correto. Ele prova deterministicamente que a ação deixou um entregável auditável quando não há melhor oracle. Exemplos: relatório de pesquisa, ADR, inventário, fixture, snapshot ou manifesto de migração. O arquivo e seu conteúdo esperado devem estar no PRD; o executor não decide no fim criar um arquivo qualquer só para se declarar concluído.

Se não houver sequer um artifact naturalmente útil, a skill pode pré-declarar um receipt de
conclusão bounded e ligado ao task ID. A tentativa precisa criar ou alterar esse arquivo com task,
resultado buscado, ação realizada, arquivos/efeitos observados e limitações. Existência/hash provam
materialização mínima — inclusive sem judge externo — mas não provam correção semântica. Isso atende
ao fallback de diff verificável sem permitir que o executor escolha uma prova conveniente depois do
fato.

## Sub-PRDs

Uma tarefa pode apontar para um arquivo child:

```markdown
  - Sub-PRD: plans/checkout-summary.prd.md
```

O child possui:

```yaml
kind: child
parent:
  prd: ../PRD.md
  task: checkout-summary
```

Regras:

- todos os children existem e validam antes de qualquer run começar;
- o graph é acíclico por canonical path + document ID;
- cada child tem exatamente um parent lógico;
- o pai passa a `[~]` quando o child começa;
- a task externa só passa a `[x]` quando todas as tasks internas e o completion contract do pai passarem;
- falha/bloqueio do child mantém o pai não concluído;
- retomada desce primeiro pela cadeia de children ativos;
- o child pode conter outro child dentro de profundidade configurável;
- defaults herdados são materializados na compilação; overrides ficam registrados;
- paths duplicados, parent mismatch e dependências cruzadas ambíguas são erros.

O “subagente” é uma instância child do runtime Ralph com run ID, ledger, events e lease próprios, vinculada ao pai por `parentRunId` e `parentTaskId`. Isso não dá ao modelo permissão para spawnar processos; somente o supervisor cria o child previsto no graph.

## Pipeline do parser

1. Ler bytes e validar UTF-8/BOM/newlines.
2. Separar e parsear YAML seguro, sem tags executáveis.
3. Parsear Markdown CommonMark preservando source positions.
4. Localizar a única seção normativa.
5. Converter cada list item de primeiro nível em task node.
6. Interpretar checkbox, strong title e labels de filhos diretos.
7. Aplicar regex apenas em ID, enum, path e lista de IDs.
8. Normalizar aliases e defaults para objeto tipado.
9. Validar JSON Schema.
10. Fazer validações semânticas: IDs, deps, cycles, paths, modes, child parent, capabilities e budgets.
11. Produzir `CompiledPrdGraph` imutável com diagnostics e source map.

O parser nunca usa uma regex multiline para compreender Markdown completo. Conteúdo livre sob Critérios/Limites é preservado como Markdown AST e texto normalizado.

## Identidade semântica e revisão

O compilador publica três hashes com finalidades diferentes:

- `taskSpecHash`, namespaced por document ID + task ID, cobre a especificação efetiva da task e ignora status/source position;
- `definitionHash` em cada documento e no graph cobre shared context, defaults, parent links, task specs sem status, dependencies, child edges, ordem e grupos;
- `graphHash` continua sendo o hash da revisão compilada, incluindo content hashes, statuses, tarefas elegíveis e demais fatos da revisão.

Trocar somente `[ ]`, `[~]` ou `[x]` altera `contentHash`/`graphHash`, mas conserva `taskSpecHash` e `definitionHash`. Alterar resultado, critério, verification, limite, dependency, defaults ou shared context altera a identidade semântica correspondente. A serialização é canônica e não incorpora paths absolutos da máquina nem source positions.

## Atualização de status

O arquivo continua sendo a visão humana do estado, porém o ledger é a autoridade durante uma transação. Para mudar status:

1. conferir hash/revision do arquivo compilado;
2. localizar exatamente a posição do marcador no source map;
3. aplicar troca de um único caractere (` `, `~`, `x`);
4. escrever em arquivo temporário, `fsync` quando suportado e renomear atomicamente;
5. reler e recompilar;
6. confirmar evento/ledger;
7. se o arquivo foi editado externamente, interromper com conflito em vez de alterar a tarefa errada.

O runtime não reserializa todo o Markdown e não altera prosa, espaçamento ou quebra de linha do autor.

## Compatibilidade com PRD clássico

O compilador detecta:

- v2 por `ralph_prd: 2`;
- v1/classic por frontmatter antigo e checklist reconhecido;
- formato desconhecido como erro com diagnóstico.

`ralph prd migrate old.md --output new.md` gera v2 sem sobrescrever por padrão e produz relatório de campos inferidos/perdidos. `ralph prd inspect --json` mostra o objeto compilado. O executor pode rodar v1 em compatibility mode, conservando semântica atual, mas recursos como child graph forte exigem v2.

Na migração, strings clássicas de command/gate permanecem instructions não executáveis: o adapter usa `change-only` mesmo quando preserva acceptance criteria e nunca transforma texto legado em argv. Somente uma reautoria explícita com gate v2 estruturado permite promover a task para `criteria`.

## Validação pela skill

A skill deve, ao finalizar geração:

1. escrever root e children;
2. chamar o parser oficial via `ralph prd validate --recursive --strict` ou biblioteca versionada;
3. corrigir todos os diagnostics;
4. confirmar que todas as tasks têm resultado, limites e evidence mode;
5. confirmar que nenhuma referência child falta;
6. emitir um resumo humano de slices/dependências sem modificar status.

Parser e skill compartilham schema, exemplos e fixtures; não mantêm gramáticas independentes.

## Critérios de aceite

- Um humano consegue entender objetivo, ordem, limites e pronto abrindo apenas os Markdown.
- O mesmo documento compila sempre no mesmo graph tipado.
- Erros apontam arquivo, linha, coluna, código e correção sugerida.
- Child ausente/cíclico impede execução antes de chamar modelo.
- O executor não possui caminho de código para gerar PRD/sub-PRD.
- Uma mudança de status preserva byte a byte todo conteúdo fora do marcador.
- PRDs clássicos continuam executáveis ou migráveis com relatório explícito.
