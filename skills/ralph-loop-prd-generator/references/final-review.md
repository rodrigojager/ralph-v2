# Revisão final e handoff

## Índice

1. Auditoria estrutural
2. Auditoria semântica
3. Validação oficial
4. Handoff

## 1. Auditoria estrutural

Conferir antes de invocar o validator:

- existe exatamente um documento `kind: root`;
- todo path em `Sub-PRD` aponta para arquivo já escrito;
- cada child declara o parent PRD e task exatos;
- IDs são estáveis, em slug, e únicos dentro de cada documento;
- dependencies referenciam tasks existentes e não formam ciclos;
- paths usam `/`, são relativos e permanecem dentro da policy do workspace;
- todas as tasks possuem Resultado, Dependências, Limites, Modo de evidência e Sub-PRD;
- modes com criteria possuem critério real e ao menos um gate determinístico capaz de produzir
  evidence; `instruction` não conta;
- modes com artifact possuem uma folha `artifact:` previamente nomeada, salvo parent com child;
- receipt de último recurso possui path/ID prévio, binding à task e conteúdo mínimo auditável;
- groups paralelos têm justificativa e fronteira de integração;
- profiles e budgets só aparecem quando fornecidos pela fonte;
- nenhum segredo literal aparece nos arquivos;
- status de autoria permanece `[ ]`, salvo migração explicitamente revisada.

## 2. Auditoria semântica

Ler os Markdown como um mantenedor que não viu a conversa:

- cada título comunica uma pequena capacidade, não uma camada;
- Resultado identifica caller/gatilho/resultado ou artifact consumível;
- a slice inclui produtores e consumidores do contrato que introduz;
- Limites impedem a expansão mais provável;
- cada critério pode ser verdadeiro ou falso de forma observável;
- a prova é proporcional e não promete semântica que só demonstra materialização;
- nenhum receipt de último recurso é apresentado como prova de correção semântica;
- o contrato de conclusão não depende da frase “o judge aprova” e permanece o mesmo em
  deterministic-only, self-review ou judge externo; profiles só aparecem quando a fonte os escolhe;
- tasks independentes não foram serializadas sem razão;
- tasks dependentes não foram colocadas em paralelo;
- completar todas as folhas de um child satisfaz o resultado do pai;
- compatibilidade, migration, rollback, configuração e observabilidade aparecem onde forem parte da
  entrega, não em uma fase genérica tardia;
- linguagem e ferramentas continuam as do projeto ou da decisão explícita do usuário.

## 3. Validação oficial

Executar no workspace do projeto:

```text
ralph-next prd validate <root-prd> --recursive --strict
ralph-next prd inspect <root-prd> --recursive --strict --format json
```

No inspect, conferir:

- root e children esperados;
- parent/child edges;
- task IDs e dependency edges;
- `definitionHash` por documento;
- `taskSpecHash` por task/ref;
- evidence modes, artifacts, command categories e skip policies;
- defaults/budgets materializados sem valores inventados.

Corrigir todos os diagnostics no Markdown e repetir. Não remover requisito, limite, child ou critério
necessário apenas para silenciar o validator. Retornar à fonte de verdade quando houver conflito.

Se o usuário proibir execução, se `ralph-next` não estiver disponível ou se a versão do validator
for incompatível, não afirmar que o graph é válido. Registrar claramente:

```text
Validação executável: pendente
Motivo: <restrição ou ferramenta ausente>
Comandos: <comandos exatos acima>
Revisão realizada: estrutural e semântica por inspeção
```

## 4. Handoff

Entregar um resumo curto contendo:

- root PRD e todos os children criados;
- número de tasks folha e pais compostos;
- ordem/dependencies e grupos paralelos;
- decisões de evidence mode, especialmente fallbacks;
- suposições e perguntas ainda abertas;
- resultado real da validação ou estado pendente;
- confirmação de que nenhum run foi iniciado e nenhum marker foi alterado.

Não duplicar todo o PRD no resumo. Os Markdown são a fonte humana; o inspect é a fonte compilada.
