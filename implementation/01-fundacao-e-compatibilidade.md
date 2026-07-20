---
task: Entregar a fundação executável e o primeiro corte de compatibilidade do Ralph v2
engine: codex
---

# Subplano S01 — Fundação e compatibilidade

## Resultado do subplano

Um usuário consegue instalar/invocar `ralph-next`, inicializar um workspace isolado e consultar help, version e status em saída humana ou JSON. O projeto já possui a direção arquitetural, schemas mínimos, event/output contract e um harness que compara uma superfície inicial do Ralph antigo sem modificar seu checkout.

## Referências obrigatórias

- `AGENTS.md`
- `docs/00-*` a `docs/05-*`
- `docs/14-*`, `docs/16-*` e `docs/17-*`
- Ralph antigo somente como referência read-only

## Políticas de execução

- Cada item abaixo termina com um comando/fluxo observável, não apenas arquivos base.
- Não copiar ainda o loop de agente nem providers do OpenCode.
- Usar `ralph-next` como nome do binário durante a construção.
- Toda saída JSON segue `CommandResult` e nunca recebe banner.
- Não criar estado global quando um estado local resolve.

## Tarefas

- [x] S01.01 criar o workspace Bun/TypeScript com entrypoint `ralph-next`, workspaces `apps/ralph-cli` e packages mínimos `domain`, `commands`, `persistence` e `telemetry`, fixar versões/lockfile, adicionar lint/format/typecheck/test e provar `ralph-next version` a partir do source e do binário/package de desenvolvimento.
- [x] S01.02 implementar resolução segura de workspace, `workspaceId`, layout `.ralph/`, schema versionado de configuração mínima e `ralph-next init`, garantindo init idempotente, paths com espaços/Unicode, recusa de sobrescrita e saída human/JSON.
- [x] S01.03 implementar o parser de commands/flags e os comandos `help`, `about`, `version` e `status`, com exit codes normativos, `--format human|json`, `--no-color`, `--debug` e precedência inicial builtin/global/workspace/env/CLI explicável por `config explain`.
- [x] S01.04 implementar store inicial e event outbox suficientes para registrar init/status sem JSON solto incoerente, criar migrations e um event envelope v1, e provar que replay de eventos da fixture reconstrói o mesmo snapshot vazio.
- [x] S01.05 criar outputs headless compartilhados, diagnostics com code/file/line quando aplicável, separação stdout/stderr e redaction básica; adicionar goldens que impedem banners, ANSI ou segredos em JSON.
- [x] S01.06 criar packaging dev/standalone experimental para Windows, Linux e macOS conforme capacidade do CI, `doctor` mínimo para runtime/Git/fs/TTY, e smoke em diretório temporário sem depender da máquina do desenvolvedor.
- [x] S01.07 construir harness black-box read-only que execute help/version/status/init selecionados do Ralph antigo e do novo em fixtures descartáveis, normalize somente IDs/timestamps, classifique diferenças e gere relatório Markdown/JSON versionado.
- [x] S01.08 escrever README de bootstrap, comandos exatos de desenvolvimento/test/package, ADRs das escolhas iniciais e atualizar a matriz de compatibilidade; executar lint, typecheck, unit, golden, packaging smoke e `git diff --check` antes de marcar o subplano.

## Critérios de conclusão

- `ralph-next init`, `status`, `help` e `version` funcionam fora do source checkout.
- `.ralph` da v2 tem identity/schema próprios e não colide com state antigo.
- Human/JSON têm testes e exit codes previsíveis.
- Harness aponta diferenças em vez de mascará-las.
- Não há provider/model call nesta slice.
- CI ou relatório local deixa claro o que foi realmente testado em cada plataforma.

## Verificação mínima

```text
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun test
bun run build
<binário> init --format json
<binário> status --format json
```

Os nomes finais dos scripts podem mudar no kickoff, mas devem estar documentados e ser não interativos.
