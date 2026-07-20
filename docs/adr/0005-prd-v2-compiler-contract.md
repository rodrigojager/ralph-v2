# ADR 0005 — Contrato do compilador PRD v2 e autoria pré-run

- Estado: aceita
- Data: 2026-07-18
- Slice: S02
- Documentos relacionados: `AGENTS.md`, `docs/01-principios-e-invariantes.md`, `docs/07-prd-v2-subprds-e-skill.md`, `docs/08-orquestracao-executor-tools-e-contexto.md`, `docs/14-compatibilidade-migracao-distribuicao-e-licencas.md`, `docs/17-contratos-e-schemas.md`, `implementation/02-prd-v2-e-skill.md`

## Contexto

O Ralph v2 precisa receber planos legíveis por humanos sem depender de interpretação probabilística para descobrir estrutura, e precisa manter detalhes suficientes para executar uma vertical slice em contexto limpo. Root e sub-PRDs também precisam ser resolvidos antes da execução para impedir que o executor amplie ou facilite o próprio escopo.

O projeto está sendo implementado atualmente com `/goal` do Codex. Esse é apenas um mecanismo de desenvolvimento deste repositório: não é parte do produto, não é backend obrigatório e não altera a finalidade do Ralph. O resultado continua sendo um CLI independente que consome PRDs próprios.

O esboço conceitual inicial de `docs/17-*` não resolvia quatro pontos necessários ao formato humano: procedimentos de verificação sem command, representação segura de command, localização concreta de artifact e shapes fechados de defaults/budget. A compatibilidade v1 ainda possui dois conflitos semânticos que não podem ser normalizados silenciosamente.

## Decisão

### Autoria antes do runtime

1. A skill externa `ralph-loop-prd-generator` é a única autora de root PRD e de todos os children
   referenciados; ela foi materializada posteriormente em `skills/ralph-loop-prd-generator/` sem
   transferir autoridade de parsing para o pacote.
2. A skill escreve o graph inteiro e executa `ralph-next prd validate <root> --recursive --strict` antes de entregar o plano.
3. O runtime Ralph detecta, compila, valida, inspeciona, migra quando comandado, executa e edita markers; ele não cria nem expande planejamento.
4. Child ausente, cycle, parent mismatch ou schema inválido falha antes de provider/model call.
5. Nenhum prompt, fallback, tool ou outcome do executor pode pedir que ele crie PRD/sub-PRD para continuar um run.
6. `/goal` permanece externo a esse fluxo e não vira dependência do Ralph.

### Estrutura e source positions

1. O frontmatter é YAML seguro e estrito, com `ralph_prd: 2` como discriminador fechado.
2. A estrutura Markdown é descoberta por CommonMark AST: uma seção `## Vertical slices`, uma lista top-level, items de task, marker, strong title e lista direta de fields.
3. Regex é permitida somente em tokens folha como slug, enum, duration, path, dependency list e assignments de budget/profile.
4. Line e column públicas são 1-based. `offset` público é sempre byte offset UTF-8 desde o início do arquivo, não offset UTF-16 do runtime JavaScript.
5. O marker tem três bytes ASCII. Edição usa content hash e byte offset para trocar somente o byte central, seguida de escrita atômica e reparse.

### VerificationSpec

O union compilado inclui cinco variantes:

- `instruction`: procedimento Markdown/texto que orienta coleta de evidência, sem execução automática;
- `command`: `CommandSpec` estruturado;
- `file`: path e expectation fechada;
- `artifact`: artifact ID, path obrigatório e schema opcional;
- `plugin`: plugin ID e input JSON.

`instruction` existe porque nem toda orientação honesta possui um executable conhecido. Ela nunca é promovida a command, compila como `never-run`/não bloqueante, fica fora da pipeline normal de gates, não recebe exit code sintético e não prova pass.

Esta decisão especializa o union conceitual inicial de `docs/17-*`: `instruction` passa a ser variante pública e `artifact.path` passa a ser obrigatório. Os JSON Schemas gerados dos validators runtime são a representação executável dessa especialização.

### CommandSpec sem string de shell

Command é representado por:

```text
executable + args[] + cwd? + environmentRefs? + shell? +
timeoutMs + successExitCodes[] + outputLimitBytes
```

Uma string de shell não é aceita como command principal. `shell` é `false` ou um objeto explícito com kind e executable opcional; script e argumentos continuam estruturados e submetidos à policy. A skill só emite commands existentes ou explicitamente requeridos pela fonte, nunca escolhe test runner ou concatena input não confiável.

### Artifact path

Toda verificação `artifact` declara:

- artifact ID slug;
- `path` relativo normalizado obrigatório;
- `schema` relativo opcional;
- blocking no objeto compilado.

Evidence mode contendo `artifact` exige verificação artifact/file ou um child que materialize o contrato previsto. O artifact é planejado antes do run e prova materialização auditável, não correção semântica além do que criteria/schema realmente verificam.

### Defaults e budgets

`TaskDefaults` aceita somente:

- executor profile;
- judge profile;
- evidence mode;
- task budget.

`TaskBudget` pode limitar model calls, tool calls, input/output/reasoning/total tokens, custo/currency, task timeout e revision attempts. Campos são opcionais, mas um budget declarado contém ao menos um limite. Documento filho herda defaults do pai; o próprio child sobrescreve por campo e budget faz merge por chave. Override de task é aplicado depois. O graph compilado materializa os valores efetivos e conserva origem suficiente para diagnóstico.

Profiles, budgets, commands e ferramentas só são emitidos quando vêm do projeto, usuário ou policy selecionada. O contrato não prescreve stack do repositório executado.

### Compatibilidade e migração v1

1. V2 é selecionado somente por `ralph_prd: 2` inteiro. Presença da chave com valor/tipo diferente é erro, nunca downgrade para o parser permissivo clássico.
2. Sem versão, frontmatter/checklist clássico reconhecido usa adapter v1 isolado. Heading `Vertical slices` sozinho não seleciona v2.
3. `[~]` no v1 significa `skipped-for-review` resolvido; no v2 significa `active`. Migração não preserva o marker silenciosamente: produz pending/manual-review conforme policy e notice `semantic-change`.
4. `depends_on` no parallel v1 referencia grupos; no v2 dependencies referenciam task IDs. Grupo singleton pode ser convertido diretamente. Grupo múltiplo é expandido conservadoramente para predecessores e reportado; referência inexistente/ambígua falha em strict.
5. Migração grava output separado por default, recusa overwrite sem autorização e emite relatório versionado de mappings, inferências, promoções, perdas e mudanças semânticas.
6. Critério ausente nunca é inventado. O adapter usa `change-only`, preserva artifact realmente declarado ou recomenda reautoria pela skill.

### Contrato consumível pela skill

S02 publica em `skill-contract/ralph-loop-prd-generator/`:

- descrição de autoridade, workflow e validação;
- vocabulário canônico PT com aliases EN declarados;
- template v2 humano e standalone válido.

A skill final de S12 empacota esse conteúdo conforme a plataforma, apontando para os mesmos schemas e validator. O diretório de contrato não é uma segunda implementação do parser.

## Consequências

### Positivas

- Humano e máquina leem a mesma fonte versionada.
- Unicode antes da task não desloca edição do marker.
- Procedimentos honestos não precisam ser convertidos em shell inseguro.
- Commands preservam boundaries de argumentos e passam por policy.
- Artifact mode sempre aponta para um entregável verificável conhecido antes do run.
- Skill e runtime não podem negociar planejamento durante uma tentativa.
- Diferenças v1 perigosas ficam explícitas e auditáveis.

### Custos e riscos

- Commands estruturados são mais verbosos no Markdown.
- `instruction` exige outro evidence mode/gate concluível; sua presença contextual nunca é pass nem bloqueio por indisponibilidade.
- Migrações v1 com grupos múltiplos ou `[~]` podem exigir revisão humana.
- A skill precisa validar vários arquivos antes de retornar, aumentando o custo de autoria para obter determinismo no run.
- Alterar aliases, variants ou unidades futuras exige evolução de schema/fixtures, não heurística silenciosa.

## Alternativas rejeitadas

- **JSON opaco ao lado do Markdown:** criaria duas fontes e prejudicaria revisão humana.
- **Regex multiline para o documento inteiro:** perderia estrutura CommonMark e source map confiável.
- **LLM no parser:** tornaria graph e diagnostics não determinísticos.
- **Command como string:** perderia boundaries e ampliaria risco de shell injection.
- **Artifact sem path:** permitiria escolher prova depois do fato.
- **Runtime criando child ausente:** permitiria ao executor modificar o próprio escopo.
- **Copiar `[~]`/`depends_on` do v1 literalmente:** mudaria status/dependency sem aviso.
- **Prescrever stack no template:** contrariaria a neutralidade do Ralph perante projetos executados.

## Evidência esperada

```text
ralph-next prd validate skill-contract/ralph-loop-prd-generator/PRD-v2.template.md --recursive --strict
ralph-next prd inspect skill-contract/ralph-loop-prd-generator/PRD-v2.template.md --recursive --strict --format json
```

Além disso:

- JSON Schemas publicados incluem `instruction`, `CommandSpec`, artifact path, defaults e budgets;
- fixture Unicode comprova byte offsets UTF-8;
- migration fixtures comprovam os dois conflitos v1 e output separado;
- scan de runtime não encontra caminho que peça ao executor autoria de PRD/sub-PRD;
- documentação e template não escolhem linguagem, framework, provider ou ferramenta do projeto.
