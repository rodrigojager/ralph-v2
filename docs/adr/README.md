# Decisões arquiteturais

Os ADRs registram escolhas já materializadas ou necessárias para as slices em implementação. Eles complementam os documentos normativos; não substituem `AGENTS.md`, `docs/00-*` a `docs/19-*` nem o subplano ativo.

| ADR | Estado | Decisão |
| --- | --- | --- |
| [0001](0001-bun-typescript-e-monorepo.md) | Aceita | Bun/TypeScript estrito e monorepo mínimo |
| [0002](0002-sqlite-outbox-e-eventos.md) | Aceita | SQLite autoritativo, outbox e eventos workspace/run |
| [0003](0003-identidade-e-resolucao-de-workspace.md) | Aceita | identidade `.ralph`, resolução de raiz, `--force` e proteção de legado |
| [0004](0004-contrato-cli-config-output-e-packaging.md) | Aceita | CLI, precedência, output e packaging experimental |
| [0005](0005-prd-v2-compiler-contract.md) | Aceita | compilador PRD v2, autoria pré-run, verificação estruturada e migração v1 |
| [0006](0006-orquestracao-s03-identidade-e-completion.md) | Aceita | orquestração S03, hashes estáveis, no-change/skip e completion coordenada |
| [0007](0007-paridade-dos-schemas-publicos-s03.md) | Aceita | paridade producer/persistence/status, bindings de evidência e contexto resolvível |
| [0008](0008-snapshot-imutavel-e-fronteira-tui-s06-s08.md) | Aceita | snapshot imutável de run e fronteira entre inspeção S06 e configuração mutável S08 |

## Convenção

Cada ADR contém contexto, decisão, consequências e evidência esperada. Uma mudança incompatível cria novo ADR que substitui o anterior e atualiza os contratos normativos afetados; decisões antigas não são apagadas.
