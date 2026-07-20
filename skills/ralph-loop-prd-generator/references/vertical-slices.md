# Vertical slices

## Índice

1. Unidade de valor
2. Mapeamento de boundaries
3. Tamanho e sequência
4. Sub-PRDs
5. Dependências e paralelismo
6. Evidência proporcional
7. Anti-patterns

## 1. Unidade de valor

Definir cada slice pela frase:

> Quando **ator/caller** realiza **gatilho**, observa **resultado**, inclusive a condição de falha
> relevante, através das boundaries necessárias.

Uma slice válida:

- entrega comportamento ou artifact consumível;
- cabe em um contexto curto e em tentativas/revisões limitadas;
- inclui o contrato mínimo entre as boundaries tocadas;
- possui início e fim observáveis;
- pode ser verificada sem esperar uma fase horizontal posterior;
- declara o que deliberadamente não entrega.

Não exigir UI, API, domínio, dados, infraestrutura e documentação em toda tarefa. Tocar somente as
boundaries necessárias ao resultado. Uma mudança só de uma camada pode ser vertical quando ela já
é a superfície consumida, como um comando CLI completo, uma migration reversível ou um contrato
publicado com consumidor real.

## 2. Mapeamento de boundaries

Para cada capacidade candidata, preencher mentalmente ou em notas temporárias:

| Pergunta | Uso |
| --- | --- |
| Quem chama ou usa? | Define o ator/caller e a superfície inicial. |
| Qual evento inicia o fluxo? | Evita tarefas vagas como “suportar X”. |
| Qual resultado pode ser observado? | Define o fim da slice. |
| Quais contratos são atravessados? | Mantém produtor e consumidor no mesmo contexto. |
| Qual estado é lido ou alterado? | Expõe dados, migration, idempotência e rollback necessários. |
| Qual falha muda a experiência? | Inclui erro útil sem expandir para toda resiliência futura. |
| Como operar e diagnosticar? | Inclui config, logs, métricas ou docs quando necessários ao uso. |
| Qual é a melhor prova disponível? | Define criteria, command, file ou artifact honesto. |

Incluir compatibilidade, rollout, segurança, acessibilidade e observabilidade na slice quando forem
condições para entregar aquele resultado, não como fases genéricas ao final.

## 3. Tamanho e sequência

Preferir o menor caminho integrado que entrega valor. Exemplos de redução:

- uma operação antes de todo CRUD;
- um happy path e sua falha contratual antes de todas as variantes;
- um consumidor real antes de generalizar abstração;
- uma migration pequena e reversível antes de migrar todos os dados;
- uma plataforma declarada antes de expandir matriz;
- um evento e sua projeção antes de toda telemetria.

Dividir quando:

- existirem dois resultados utilizáveis independentemente;
- a tarefa exigir mais de um rollout ou rollback autônomo;
- critérios puderem aprovar uma metade e reprovar outra sem contradição;
- o contexto necessário deixar de caber em uma tentativa curta;
- houver boundaries não relacionadas compartilhando apenas conveniência de implementação.

Não dividir produtor e consumidor de um contrato novo se nenhum deles entregar valor isolado. Se a
fundação for indispensável, incorporá-la à primeira slice consumidora ou entregar um artifact
operacional real, como schema versionado, migration reversível ou ADR consumido imediatamente.

Usar expand/contract quando uma mudança ampla precisar preservar compatibilidade:

1. expandir contrato compatível dentro da primeira slice consumidora;
2. migrar consumidores em pequenos resultados integrados;
3. contrair a forma antiga somente depois de prova e rollout explícitos.

## 4. Sub-PRDs

Criar child quando a tarefa pai representa um único resultado externo, mas precisa de várias slices
internas para manter cada contexto pequeno. Exemplos: migration longa por estágios, integração com
várias boundaries independentes ou rollout que precisa de preparação, adoção e contração.

Não criar child apenas para esconder uma lista extensa, nem para transferir planejamento ao runtime.
Antes da execução:

- escrever o child no path declarado;
- declarar `kind: child` e o parent exato;
- tornar IDs únicos no documento e dependências locais explícitas;
- validar recursivamente root e descendants;
- confirmar que completar todas as folhas satisfaz o resultado e o completion contract do pai.

O pai descreve o resultado externo e os limites. As tasks internas descrevem incrementos que
compõem esse resultado. O pai não fica concluído só porque o child foi criado; todos os descendants
e artifacts exigidos precisam estar reconciliados.

## 5. Dependências e paralelismo

Declarar dependência somente quando uma task precisa do resultado concluído de outra. Não usar
dependência para expressar preferência estética de ordem.

Antes de colocar tasks no mesmo grupo paralelo, confirmar:

- contratos de entrada/saída já estão definidos;
- não dependem do mesmo arquivo ou estado mutável sem estratégia;
- cada uma pode ser aprovada isoladamente;
- a integração/merge é determinística e possui owner;
- falha de uma não transforma o trabalho da outra em efeito externo incerto.

Se qualquer resposta for negativa, sequenciar ou criar uma slice que estabilize o contrato primeiro.
Não agrupar apenas para aumentar velocidade.

## 6. Evidência proporcional

Selecionar na ordem:

1. critérios falsificáveis sustentados pela fonte;
2. verificações estruturadas existentes no projeto;
3. inspeção de arquivo ou artifact declarado;
4. diff permitido não vazio quando esse for o melhor sinal disponível;
5. receipt de conclusão bounded e pré-declarado quando não existir outro entregável material;
6. revisão humana explícita quando até uma mudança material for proibida ou inadequada.

Não inventar comando pela aparência do stack. Extrair executable e args de manifests, automação,
documentação ou decisão explícita. Classificar command como test/lint/build/security somente quando
a fonte sustentar essa categoria e sua skip policy.

Um artifact de último recurso deve continuar útil depois da aprovação: ADR, inventário, relatório,
manifesto, schema, fixture, snapshot, migration ou índice de evidências. Declarar ID, path e, quando
existir, schema/hash/expectativa.

Quando nem mesmo um artifact naturalmente útil existir, a skill pode declarar um receipt de
conclusão específico da task. Ele deve ter path relativo e ID conhecidos antes do run, ser criado ou
alterado pelo executor e conter task ID, resultado pretendido, ação realizada, arquivos/efeitos
observados e limitações. A verificação determinística confirma arquivo não vazio/hash; ela não
converte o receipt em prova de correção semântica. Nunca usar arquivo vazio, aleatório, sem binding à
task ou escolhido depois do fato.

## 7. Anti-patterns

Reescrever estas formas antes de entregar:

- “fazer backend”, “fazer frontend”, “configurar infra”, “adicionar testes” como fases separadas;
- “pesquisar X” sem artifact consumível e decisão esperada;
- “refatorar camada” sem comportamento, compatibilidade ou artifact observável;
- tarefa que depende de “conectar depois” para funcionar;
- critério tautológico como “o código foi implementado corretamente”;
- comando inventado ou shell string formada com input não confiável;
- Sub-PRD ausente que o executor deverá criar;
- grupo paralelo com contrato ainda em disputa;
- arquivo vazio/aleatório ou receipt sem binding e conteúdo mínimo que só tenta enganar o diff;
- task ampla cuja aprovação oculta resultados independentes parcialmente falhos.
