# ADR 0002 — SQLite autoritativo, outbox e eventos com escopo

- Estado: aceita
- Data: 2026-07-18
- Slice: S01
- Documentos relacionados: `docs/01-principios-e-invariantes.md`, `docs/10-persistencia-retomada-watchdog-e-filhos.md`, `docs/11-eventos-telemetria-logs-e-relatorios.md`, `docs/17-contratos-e-schemas.md`

## Contexto

Mesmo antes de runs e tarefas, `init` precisa registrar um fato durável que possa ser exibido por `status`, exportado e reproduzido. JSONs soltos não oferecem transação, constraints, migration ou coordenação adequada para a retomada e concorrência futuras.

O envelope normativo original pressupunha `runId`, mas inicialização e alteração de configuração acontecem antes de existir um run. Criar um run artificial apenas para satisfazer o schema misturaria lifecycle de workspace com lifecycle de execução.

Também existe uma tensão entre duas necessidades:

- SQLite precisa ser a fonte de verdade transacional;
- JSONL precisa permanecer legível/exportável e útil para replay/integrações.

Gravar ambos independentemente permitiria estado sem evento ou evento que não corresponde ao estado confirmado.

## Decisão

1. Usar SQLite por meio de `bun:sqlite` como store autoritativo local.
2. Habilitar foreign keys, WAL e busy timeout e controlar schema por migrations forward-only registradas.
3. Persistir o event envelope na mesma transação lógica que adiciona uma linha à outbox.
4. Fazer um flusher materializar eventos pendentes em `.ralph/events.jsonl` com deduplicação por `eventId`, oferecendo semântica at-least-once no transporte e exactly-once lógico para consumers que deduplicam.
5. Versionar `EventEnvelope` com:
   - `scope: "workspace" | "run"`;
   - `streamId`, que define a sequência monotônica;
   - `runId` opcional para eventos de workspace e obrigatório, por validação, em eventos de run.
6. Usar `scope: workspace` para `workspace.initialized`/`workspace.repaired`; nunca criar run sintético para esses eventos.
7. Considerar SQLite autoridade em divergência. JSONL é export/projeção recuperável pelo ledger/outbox.
8. Redigir payload potencialmente sensível antes de persistência; redaction posterior não é suficiente.
9. Validar produtores com envelope estrito, mas gerar o JSON Schema público a partir do consumer forward-compatible: campos conhecidos continuam obrigatórios/tipados e campos aditivos da mesma major version são preservados. `schemaVersion` incompatível permanece rejeitado.
10. Persistir paths de payload relativos ao workspace e com separador `/`. O path canônico diagnóstico existe somente em `workspace.json`; eventos de init/repair não repetem o path absoluto e `repairedPaths` usa entradas como `.ralph/config.yaml`.

## Fluxo da S01

```text
init
  -> transação SQLite: event + outbox
  -> commit
  -> flush append-only para .ralph/events.jsonl
  -> replay do ledger
  -> status
```

`sequence` cresce por `streamId`. `eventId` identifica deduplicação; timestamp UTC e relógio monotônico têm funções distintas.

## Consequências

### Positivas

- A fundação já possui migrations e uma fonte coerente para replay.
- Eventos anteriores a runs deixam de exigir IDs falsos.
- TUI/headless futuros poderão consumir o mesmo contrato sem raspar output.
- Falha depois do commit e antes do append JSONL deixa outbox recuperável.

### Custos e riscos

- Existem duas representações físicas que precisam de reconciliação.
- Corrupção ou cauda truncada de JSONL precisa ser reparada a partir do ledger.
- Migrações, locking e concorrência precisam de testes específicos por plataforma.

## Limites da S01

- O store registra somente o mínimo de workspace/eventos; runs, tasks, attempts, leases e completion preparada chegam nas slices proprietárias.
- `events.jsonl` de workspace não substitui a futura árvore `.ralph/runs/<run-id>/events.jsonl`.
- A implementação inicial não declara ainda crash recovery completa; ela estabelece o contrato e a migration inicial.
- Na S01, o flush operacional ocorre sob o lock de inicialização do workspace. Coordenação entre múltiplos flushers/workers, leases e recuperação automática de processos pertence à S07; chamar o helper de flush concorrentemente fora desse fluxo ainda não é uma API pública suportada.

## Evidência esperada

- `init` cria ledger e migration sem JSON de estado paralelo incoerente.
- Repetir `init` não duplica `workspace.initialized`.
- Replay da fixture reconstrói o snapshot vazio esperado e é idempotente.
- Interromper/reexecutar o flush não duplica eventos por `eventId`.
- JSONL não contém banner, ANSI ou secret canary.
