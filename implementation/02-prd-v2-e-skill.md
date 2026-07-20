---
task: Entregar parser forte de PRD v1 e v2, graph de sub-PRDs e contrato da skill
engine: codex
---

# Subplano S02 — PRD v2 e skill

## Resultado do subplano

Um humano escreve/lê Markdown normal e o Ralph compila exatamente a mesma estrutura em um graph tipado. O CLI valida, inspeciona e migra PRD; referências child são resolvidas antes da execução; mudar status altera somente o checkbox. A responsabilidade de autoria da skill fica explícita e testável.

## Referências obrigatórias

- `docs/07-prd-v2-subprds-e-skill.md`
- `docs/16-plano-de-implementacao-vertical.md`
- `docs/17-contratos-e-schemas.md`
- `examples/` após serem criados nesta slice

## Tarefas

- [x] S02.01 definir schemas runtime e TypeScript de `PrdDocument`, `PrdTask`, criteria, verification, defaults, source locations, diagnostics e `CompiledPrdGraph`, gerar JSON Schema publicado e fixtures mínimas válida/inválida sem implementar parsing por regex global.
- [x] S02.02 implementar leitura UTF-8, YAML frontmatter seguro e CommonMark AST com source positions, localizar a seção `Vertical slices`, extrair itens top-level, markers, strong title e labels normativos preservando Markdown livre e offsets.
- [x] S02.03 implementar normalização PT/EN declarada, leaf parsers de IDs/enums/paths/dependencies/durations/budgets e diagnostics estáveis com code, line, column e hint; rejeitar labels desconhecidos/duplicados e conteúdo ambíguo.
- [x] S02.04 implementar validação semântica de resultado/limites/evidence modes, dependências inexistentes/cíclicas, ordem elegível, group metadata, paths canonicalizados e configuração que não force critério artificial em tasks change-only/artifact.
- [x] S02.05 resolver recursivamente todos os sub-PRDs, validar kind/parent, canonical path, graph cycles, max depth/count e defaults materializados; provar que nenhum model/backend é chamado quando child falta ou é inválido.
- [x] S02.06 implementar source map e editor transacional de marker `[ ]/[~]/[x]` com precondition por content hash, temp write/rename/reparse/reconciliation; property test deve provar preservação byte a byte de todo o restante do arquivo e detectar edição externa concorrente.
- [x] S02.07 implementar adapter de PRD clássico v1 e os comandos `prd validate`, `prd inspect`, `prd format` e `prd migrate`, com `--recursive`, `--strict`, human/JSON e output separado por default; gerar relatório de inferências/perdas sem inventar critérios.
- [x] S02.08 criar `examples/PRD-v2-exemplo.md` e `examples/subprd-v2-exemplo.md`, parser goldens, fuzz/property tests, documentos com espaços/Unicode/CRLF e fixtures de todos os diagnostics críticos.
- [x] S02.09 materializar o contrato consumível pela futura skill: schema, vocabulário, template, command de validação e teste que procura qualquer runtime path capaz de pedir ao executor geração de PRD/sub-PRD; documentar que autoria ocorre antes do run.

## Critérios de conclusão

- Root e children de exemplo validam em strict/recursive.
- Child ausente/cíclico/parent mismatch falha antes de model call.
- `inspect --format json` é schema-valid e estável.
- Marker edit não reformata o Markdown.
- PRD v1 fixture continua legível e migrável.
- O runtime não possui fallback de “pedir à IA para criar child”.

## Verificação mínima

```text
ralph-next prd validate examples/PRD-v2-exemplo.md --recursive --strict
ralph-next prd inspect examples/PRD-v2-exemplo.md --recursive --strict --format json
ralph-next prd migrate <fixture-v1> --output <temp-v2>
bun test packages/prd
```
