# 19 — Decisões, riscos e não objetivos

## Decisões já tomadas

1. O projeto é novo e isolado em `Desktop/ralph-v2`; o Ralph atual não é reescrito in-place.
2. A linguagem/ecossistema alvo é TypeScript com Bun, SolidJS/OpenTUI para TUI, alinhado ao OpenCode auditado.
3. O Ralph continua command-authoritative; modelos são drivers/ferramentas.
4. Não se chamará o agente OpenCode para ser Ralph/executor/judge como arquitetura principal.
5. Código OpenCode será transplantado seletivamente, fixado, atribuído e adaptado atrás de ports próprios.
6. Executor e judge usam perfis independentes.
7. Judge externo é opcional; self-review é opcional; deterministic-only é válido.
8. Score é 0–100; threshold, severidade e máximo de revisões são policy do Ralph.
9. PRD v2 é Markdown + YAML + AST + schema, não JSON opaco nem regex global.
10. Somente a skill futura gera root e children antes do runtime.
11. Evidence mode pode ser criteria, change e/ou artifact; o runtime não inventa critério.
12. Resume prioriza a mesma task/child não concluído e preserva alterações parciais.
13. Watchdog é multi-sinal e conservador contra falso positivo.
14. TUI e headless consomem eventos próprios versionados.
15. Barra representa apenas tasks duravelmente concluídas sobre total e usa a largura disponível como 100%.
16. Toda configuração visual possui equivalente CLI/config.
17. O executável começa como `ralph-next` e só assume `ralph` após gate.
18. Opções efetivas de um run persistido são snapshot imutável: attach/replay apenas inspeciona; a TUI aplica overrides ao draft pré-run ou salva defaults para runs futuros.

## Pontos deliberadamente configuráveis

Não são decisões de linguagem/ferramenta do projeto-alvo executado pelo Ralph; são policies do próprio CLI:

- provider/modelo/credencial executor e judge;
- auth disponível por driver;
- threshold, rubrica, severity rules e revisões;
- deterministic/self/external/manual evaluation;
- gates/commands/skips/fast/no-change/evidence;
- once/loop/wiggum/parallel;
- calls/tokens/custo/retries/timeouts;
- watchdog thresholds/action;
- background/attach/stop behavior;
- Git branch/commit/PR/integration/worktree;
- sandbox/rede/security;
- theme/ASCII/locale/layout;
- raw retention/telemetry.

O Ralph não obriga linguagem, framework, banco, cloud, test runner ou infraestrutura do projeto que ele implementa.

## Riscos e mitigação

### Deriva do OpenCode

**Risco:** APIs internas, OAuth, provider metadata e componentes são privados/voláteis.

**Mitigação:** commit fixo, source transplant mínimo, ports próprios, fixtures, vendor refresh manual e sem tipos upstream persistidos.

### Autenticação por assinatura muda

**Risco:** fluxo ChatGPT/conta pode mudar por política, endpoint ou elegibilidade.

**Mitigação:** driver isolado, fail closed, capability/status claro, update explícito, API key e CLI externo como opções independentes — nunca fallback silencioso.

### Cópia excessiva vira fork impossível

**Risco:** importar session/server/database do OpenCode aumenta manutenção e inverte autoridade.

**Mitigação:** lista positiva de módulos, dependency review, limite por port, `copied-files.md` e rejeição de dependências privadas desnecessárias.

### Provider variance

**Risco:** tools, reasoning, tokens e finish diferem e a TUI mente.

**Mitigação:** schema próprio, source de usage, `unavailable`, raw preservation, golden streams e capability filtering.

### Judge parece objetivo, mas também alucina

**Risco:** score inconsistente ou leniente.

**Mitigação:** gates primeiro, evidence refs, schema/rubrica, provider independente configurável, threshold/severity Ralph, histórico/revisões e manual mode quando necessário.

### Self-review mantém viés

**Risco:** executor aprova a si mesmo.

**Mitigação:** rotular como self, usar nova chamada/contexto, mesmo contrato e gates; usuário escolhe deterministic-only ou external judge.

### Critérios artificiais

**Risco:** skill inventa verificações sem valor para preencher schema.

**Mitigação:** evidence modes explícitos, permitir `change-only`/artifact útil e diagnostics em vez de inventar semântica.

### Artifact vazio vira selo falso

**Risco:** criar qualquer arquivo parece conclusão.

**Mitigação:** path/tipo/schema/conteúdo mínimo declarados pela skill, hash/evidence e relatório que deixa claro que artifact prova materialização, não correção completa.

### Crash consistency

**Risco:** marker, ledger, Git e events divergem.

**Mitigação:** prepared completion, atomic marker write, outbox, hashes, reconciliation e kill-injection matrix.

### Efeitos externos duplicados após resume

**Risco:** tool chamada novamente cria deploy/PR/mensagem duplicada.

**Mitigação:** intent antes de efeito, idempotency key, effect classification e manual reconciliation para unsettled externo.

### Watchdog mata trabalho lento

**Risco:** provider/build silencioso é confundido com hang.

**Mitigação:** heartbeat separado de progresso, process/provider probes, grace/confirmations/phases/hard timeout e false-positive suite.

### Watchdog não detecta deadlock “vivo”

**Risco:** PID/heartbeat superficial existe, sem progresso real.

**Mitigação:** phase deadlines, semantic IPC ping, progress age, repeated probes e hard timeout opcional.

### Parent/child cycles e explosão

**Risco:** recursão infinita ou muitos processos.

**Mitigação:** validação global prévia, canonical path/IDs, max depth/count/concurrency e spawn somente do graph.

### Concorrência/Git

**Risco:** slices tocam arquivos comuns, conflitos ou corrupção.

**Mitigação:** groups/claims/worktrees, integration branch/gates e pause explícito em conflito.

### TUI bloqueia motor

**Risco:** muitos deltas/outputs congelam render e heartbeat.

**Mitigação:** process/event separation, bounded channels, coalescing de display, raw writer, snapshots/cursors e load tests.

### Barra enganosa

**Risco:** task ativa preenche percentual arbitrário ou children contam duas vezes.

**Mitigação:** completed/total único, active separado, scope/aggregate rotulado e fórmula property-tested.

### Secrets em contexto/log

**Risco:** token de conta/API aparece em prompt, events ou crash dump.

**Mitigação:** credential refs, OS keychain, resolução tardia, redaction canaries, judge read-only e raw storage protegido.

### Diferenças de Windows

**Risco:** signals, job/process tree, path locks, junctions e standalone Bun divergem.

**Mitigação:** Windows como plataforma CI de primeira classe, job objects/equivalente, canonical path tests, PTY/packaging smoke e diagnostics.

### Escopo excessivo

**Risco:** tentar reproduzir todo OpenCode e todo Ralph antes de entregar valor.

**Mitigação:** S01–S12 verticais, `ralph-next`, lista de não objetivos e gate contra módulo sem fluxo observável.

## Não objetivos da v2 inicial

- ser uma IDE/editor geral;
- substituir OpenCode como produto ou manter compatibilidade de sessão com ele;
- copiar branding/interface pixel a pixel;
- hospedar marketplace amplo de agentes no primeiro release;
- permitir que modelos reescrevam PRD/policy durante a execução;
- escolher stack do projeto do usuário;
- garantir semântica perfeita somente porque um arquivo mudou;
- suportar todo provider existente sem driver/teste;
- fazer deploy/PR/efeito externo sem autorização explícita;
- sincronizar state de um mesmo run entre máquinas sem desenho de distributed lease;
- calcular percentual interno de “pensamento” da IA;
- prometer custo exato quando provider não reporta tokens/preço;
- apagar automaticamente branches/worktrees/alterações para “consertar” um run.

## Questões a confirmar no kickoff sem bloquear o plano

Estas escolhas têm defaults recomendados, mas podem ser ajustadas antes da implementação:

- nome do package/scope e licença própria do Ralph v2;
- banco durável final (SQLite é a referência arquitetural);
- biblioteca runtime-schema;
- método IPC local;
- plataformas/arquiteturas de release inicial;
- matriz explícita `included`/`not-promoted` por versão/canal e motivo de cada exclusão;
- secret store adapters prioritários;
- commit OpenCode definitivo, se mais novo que o snapshot auditado;
- default threshold/revision/watchdog durations;
- política default ao fechar TUI (perguntar manter/stop);
- aggregate progress por leaf ou root (root/child separados continuam obrigatórios).

Escolher esses valores não pode alterar as invariantes. Toda decisão final deve virar ADR curto e atualizar schema/testes/rastreabilidade.

## Critério para mudar este plano

Uma mudança arquitetural precisa explicar:

1. qual requisito/risco motivou;
2. quais invariantes preserva;
3. quais documentos/schemas/slices afeta;
4. como migra state/config/PRD;
5. qual teste prova o novo comportamento.

Alterar apenas o código sem atualizar plano e matriz é considerado implementação incompleta.
