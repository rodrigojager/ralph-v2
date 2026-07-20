# 01 — Princípios e invariantes

## 1. Comandos governam a IA

O Ralph é control plane e máquina de estados. A IA é um executor consultado pelo comando.

Somente o Ralph decide:

- qual PRD e qual tarefa estão ativos;
- qual contexto é fornecido;
- qual provider, modelo, variante e credencial são usados;
- quais tools existem e quais chamadas são autorizadas;
- limites de passos, tokens, tempo, retries e revisões;
- quando gates, judge ou self-review são executados;
- se uma evidência é suficiente;
- quando uma tarefa, tentativa, run ou filho muda de estado;
- quando criar processo, worktree, branch, commit, PR, checkpoint ou rollback.

O texto “terminei” nunca é uma transição de estado.

## 2. Uma vertical slice por contexto de tarefa

Uma tarefa válida entrega um comportamento estreito do gatilho ao resultado observável, tocando todas as camadas necessárias. Ela não é dividida artificialmente em “todo backend”, “todo frontend” e “integração depois”.

Cada execução recebe apenas o contexto autorizado para aquela tarefa e parte do estado real do repositório. A próxima tarefa começa em nova invocação, sem depender da memória da anterior.

## 3. Estado fora da LLM

Fontes de estado:

- PRD e sub-PRDs para definição e conclusão final humana;
- ledger transacional para run, tarefa, tentativa, tools, judge e leases;
- event log para auditoria e replay;
- filesystem e Git para alterações;
- gates e artefatos para prova.

Mensagens internas ou reasoning do modelo não são fonte de verdade.

## 4. Evidência antes de opinião

A ordem é:

1. integridade do run e do workspace;
2. evidências determinísticas obrigatórias;
3. verificação comportamental ou inspeção declarada;
4. judge/self-review, quando configurado;
5. política explícita de fallback.

Uma nota não sobrepõe gate bloqueante nem critério obrigatório falho.

## 5. Judge é consultor estruturado

O judge retorna nota e parecer. O Ralph aplica threshold e políticas. O judge não marca checkbox, não edita arquivos, não muda threshold e não decide quantas revisões restam.

## 6. PRDs são authored, não improvisados

A skill gera ou reescreve PRD e sub-PRDs antes do runtime. O executor do Ralph não cria um sub-PRD porque faltou detalhe. Ausência ou invalidade é erro de validação, não convite para improvisação.

## 7. Humano e máquina leem a mesma fonte

O PRD v2 usa Markdown visível. Campos autoritativos são explícitos. Não existe um JSON oculto diferente do texto mostrado ao humano. O parser usa AST, schema e validação semântica; não tenta “entender” prose por LLM.

## 8. Retomada é padrão

Qualquer tarefa iniciada e não finalizada continua sendo a candidata de retomada. Se nenhuma tarefa estava ativa, a primeira pendente e elegível é escolhida. Um child run incompleto é retomado antes de o pai avançar.

## 9. Lentidão não é travamento

Ausência de tokens ou output não basta para matar um worker. Heartbeat de controle, progresso, estado do processo, lease e deadline de fase são sinais separados. O watchdog confirma uma falha usando múltiplos sinais.

## 10. UI não possui regras exclusivas

Toda ação da TUI despacha um comando. Todo painel deriva do event bus/ledger. Fechar a TUI não altera a semântica da execução. O CLI headless pode observar e controlar o mesmo run.

## 11. Métricas não são inventadas

- Progresso percentual representa itens discretos concluídos sobre o total.
- Não há percentual estimado de “quanto falta para o modelo pensar”.
- Tokens e custo indicam se foram reportados, estimados ou indisponíveis.
- Reasoning visível é apenas summary/conteúdo fornecido pelo provider.
- Dados ausentes aparecem como ausentes, não como zero.

## 12. Configuração não depende da TUI

Qualquer valor configurável por popup possui chave documentada, comando headless e schema. A TUI é um editor conveniente, não uma camada paralela.

## 13. Roles são independentes

Executor e judge têm provider, modelo, credencial, variante, orçamento e fallback próprios. Eles podem compartilhar configuração, mas nunca são implicitamente o mesmo perfil.

## 14. Capabilities são validadas

Um modelo executor precisa oferecer as capacidades necessárias para o backend escolhido, especialmente tool calling no modo embutido. Um judge pode exigir apenas texto/structured output. A seleção filtra ou alerta combinações incompatíveis.

## 15. Falhas não são misturadas

Contadores distintos:

- retry de provider/transport;
- retry de parsing/schema de resposta;
- tentativa de execução;
- tentativa de no-change;
- revisão causada pelo judge;
- restart do watchdog;
- retry de tarefa paralela.

## 16. Segurança e proveniência são parte do produto

Secrets usam armazenamento apropriado e referências. Output é redigido antes de persistência. Código derivado do OpenCode mantém licença, commit e mapa de arquivos. A aparência pode ser inspirada/adaptada sem reutilizar nome, logo ou identidade enganosa.

## 17. O alvo é agnóstico de stack

TypeScript/Bun é a implementação do Ralph. Não é requisito para os repositórios que ele executa. PRD, skill, tools, gates e evidências aceitam qualquer stack definida pelo projeto.
