# ADR 0001 — Bun, TypeScript estrito e monorepo mínimo

- Estado: aceita
- Data: 2026-07-18
- Slice: S01
- Documentos relacionados: `AGENTS.md`, `docs/03-arquitetura-e-modulos.md`, `docs/14-compatibilidade-migracao-distribuicao-e-licencas.md`, `docs/16-plano-de-implementacao-vertical.md`

## Contexto

O Ralph v2 precisa nascer em um projeto isolado do Ralph clássico, com um entrypoint instalável, contratos testáveis e um caminho para adaptar futuramente partes selecionadas do ecossistema OpenCode/OpenTUI. A fundação também precisa produzir standalones para Windows, Linux e macOS sem confundir compilação cruzada com suporte comprovado.

Uma estrutura monolítica facilitaria o primeiro arquivo, mas tornaria nebulosa a direção de dependências entre command handlers, domínio, persistência e telemetria. Ao mesmo tempo, criar desde S01 todos os packages previstos para S02–S12 seria implementação horizontal sem fluxo observável.

## Decisão

1. Usar Bun `1.3.14` como runtime, package manager, test runner, bundler e compiler standalone da S01.
2. Fixar `packageManager`, versões diretas e `bun.lock`; CI instala com `bun install --frozen-lockfile`.
3. Usar TypeScript em modo estrito, com typecheck sem emissão e sem transformar o domínio inteiro em um framework de effects.
4. Organizar a fundação em workspaces mínimos:
   - `apps/ralph-cli`: entrypoint e bootstrap do executável `ralph-next`;
   - `packages/commands`: parsing e handlers públicos;
   - `packages/domain`: schemas runtime, tipos e regras compartilhadas;
   - `packages/persistence`: workspace, config, ledger, migrations e outbox;
   - `packages/telemetry`: eventos, output e redaction.
5. Adicionar packages futuros somente na slice que entrega um comportamento vertical que os utiliza.
6. Manter contratos públicos próprios do Ralph. Tipos internos de Bun ou de qualquer upstream não viram schema persistido sem adaptação/versionamento.
7. Tratar `ralph-next` como nome de desenvolvimento/beta. O nome `ralph` permanece reservado até o gate de compatibilidade e release.
8. Manter uma matriz fechada `win32|linux|darwin` × `x64|arm64`; host/arquitetura fora dela e flags de build desconhecidas ou ambíguas são erros, nunca fallback para Linux/x64 ou build nativo silencioso.

## Direção de dependências na S01

```text
apps/ralph-cli -> commands -> domain
                         -> persistence -> domain
                         -> telemetry   -> domain
persistence -> telemetry (event envelope/replay)
```

Providers, TUI, PRD compiler e orquestração não entram na fundação. Quando existirem, devem respeitar a direção normativa de `docs/03-*` e não obter autoridade sobre estado oficial.

## Consequências

### Positivas

- O source, os testes e o standalone usam a mesma runtime/toolchain.
- Fronteiras mínimas ficam verificáveis sem antecipar S02+.
- O nome lado a lado evita substituir acidentalmente o CLI antigo.
- Versões e lockfile reduzem variação entre máquinas e CI.

### Custos e riscos

- Bun e seu compiler standalone podem divergir por plataforma/arquitetura.
- Um executable gerado em cross-build não pode ser executado no host de build para provar compatibilidade.
- TypeScript `paths` e workspaces precisam permanecer alinhados com bundling e testes.

## Mitigações

- Matriz nativa de CI em Windows, Linux e macOS.
- Smoke executa o standalone nativo fora do checkout.
- Metadata de cada build começa como `built-not-tested`; somente execução nativa muda a evidência externa.
- `bun run build:all` é experimental e não constitui um gate de release.

## Evidência esperada

```text
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun test
bun run build
bun run smoke
```

O smoke precisa invocar `version`, `help`, `about`, `init`, `status`, `config list`, `config explain` e `doctor` por um standalone copiado para uma fixture externa ao checkout, validando também o contrato específico dos checks mínimos de `doctor`.
