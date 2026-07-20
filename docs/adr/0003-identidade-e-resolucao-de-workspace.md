# ADR 0003 — Identidade, resolução de workspace, `--force` e legado

- Estado: aceita
- Data: 2026-07-18
- Slice: S01
- Documentos relacionados: `docs/10-persistencia-retomada-watchdog-e-filhos.md`, `docs/14-compatibilidade-migracao-distribuicao-e-licencas.md`, `docs/19-decisoes-riscos-e-nao-objetivos.md`

## Contexto

O Ralph clássico e o Ralph v2 precisam coexistir. Ambos usam um diretório chamado `.ralph`, por isso a presença desse nome, sozinha, não prova que o state pertence à v2. Um `init --force` permissivo poderia sobrescrever estado legado, um diretório criado por outra ferramenta ou arquivos parcialmente recuperáveis.

Paths também não são identidade suficiente: o projeto pode ser movido ou copiado, múltiplos Ralphs podem rodar em projetos diferentes e o comando pode ser chamado em um subdiretório.

## Decisão

1. Todo workspace v2 válido possui `.ralph/workspace.json` com schema estrito:
   - `schema_version: 1`;
   - `product: ralph-v2`;
   - `workspace_id`: UUID persistido;
   - `canonical_root`;
   - timestamp e versão criadora.
2. O UUID persistido é a identidade; canonical path é metadata usada para detectar movimento/cópia, não substituto do ID.
3. Com `--workspace`, resolver e validar exatamente o diretório informado.
4. Sem path explícito, comandos de inspeção procuram o primeiro `.ralph` em ancestrais a partir do diretório atual e então validam sua identidade. A descoberta para na raiz do filesystem e nunca atravessa um `.ralph` vazio, malformado ou estrangeiro para anexar silenciosamente a um workspace mais alto.
5. `status` em diretório não inicializado retorna sucesso com estado `uninitialized` e não cria arquivos.
6. `init` cria apenas state v2. Ele não cria, reescreve nem escolhe PRD na S01.
7. Um `.ralph` ausente ou vazio pode receber a identidade v2.
8. Um `.ralph` não vazio sem identidade v2 válida é recusado com exit code de conflito e orientação de migração futura.
9. Um workspace identificado, porém incompleto, é bloqueado por default. `init --force` pode recriar somente arquivos v2 ausentes conhecidos; não sobrescreve config, ledger, identity, PRD ou conteúdo desconhecido.
10. Escritas de identity/config usam arquivo temporário e rename/replace seguro conforme a operação. Paths com espaços e Unicode são obrigatórios nos testes.

## Layout inicial

```text
.ralph/
  workspace.json       sentinela/identidade v2
  config.yaml          configuração humana schema v1
  events.jsonl         projeção de eventos do workspace
  state/
    ledger.sqlite      autoridade transacional
    migrations/
  runs/
  locks/
  cache/
  checkpoints/
```

O layout reserva diretórios necessários às próximas slices, mas não implica que runs, leases ou checkpoints já estejam implementados.

## Compatibilidade deliberada

A v2 difere do Ralph clássico ao descobrir um workspace identificado em ancestrais. Essa diferença é intencional e deve aparecer no relatório black-box, não ser mascarada por normalização.

O cenário obrigatório `status-descendant` inicializa cada produto em uma fixture ancestral, executa `status` em um descendente com espaço/Unicode e prova simultaneamente que a v2 encontra a identidade ancestral, o legado permanece não inicializado naquele cwd e nenhum dos dois comandos cria state no descendente ou muta o state do pai.

`--force` também é deliberadamente conservador: ele repara ausência conhecida, mas nunca transforma um state não identificado em v2. Migração de state legado pertence à S10 e exige inspect/preview/backup.

## Consequências

### Positivas

- Projetos diferentes mantêm UUID, locks e estado separados.
- O checkout antigo e workspaces legados ficam protegidos contra init acidental.
- Um comando em subdiretório encontra o root v2 de modo previsível.
- Movimento do projeto pode ser diagnosticado sem fingir que o path é identidade.

### Custos e riscos

- Um `.ralph` parcialmente criado antes da gravação da sentinela é tratado como desconhecido e exige inspeção humana.
- Cópias do diretório preservam UUID e precisam de reconciliação futura antes de concorrência distribuída.
- Symlinks/junctions e diferenças de casing exigem canonicalização específica por plataforma.

## Limite de locking da S01

O lock exclusivo de `init` impede duas inicializações locais simultâneas e nunca é criado dentro do `.ralph` desconhecido. Se o processo morrer sem executar o cleanup, a S01 bloqueia após timeout e orienta inspeção/remoção manual apenas do arquivo `.ralph-v2-init.lock`. Validação de PID reciclado, lease/heartbeat, recuperação automática e supervisão de árvore de processos são responsabilidade da S07; a fundação não simula essas garantias.

## Evidência esperada

- `init` novo e repetido são previsíveis e idempotentes.
- `status` não inicializado não muta o diretório.
- Execução em subdiretório encontra o root v2.
- Fixtures com espaço/Unicode funcionam.
- `.ralph` legado/desconhecido é recusado mesmo com `--force`.
- Remover somente config/ledger de um workspace v2 exige `--force` e preserva arquivos existentes.
