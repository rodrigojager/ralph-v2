# 03 — Arquitetura e módulos

## Visão geral

```text
CLI/TUI clients
      │ commands
      ▼
Supervisor + command handlers
      │
      ▼
Deterministic orchestration state machine
 ├── PRD compiler/validator
 ├── run ledger + event bus
 ├── model driver registry
 ├── tool host + permission policy
 ├── evidence/gate pipeline
 ├── evaluation service
 ├── child/parallel supervisor
 ├── Git/checkpoint/sandbox services
 └── reports/telemetry aggregation
```

## Estrutura pretendida

```text
apps/
  ralph-cli/             entrypoint, parsing e output headless

packages/
  commands/              comandos públicos e resolução de opções
  domain/                tipos e regras puras de run/task/attempt
  prd/                   Markdown AST, schema, graph e edições posicionais
  orchestration/         máquina de estados autoritativa
  model-drivers/         providers embutidos e backend CLI externo
  credentials/           auth, refresh e secret references
  model-catalog/         capabilities, limites, variantes e preços
  tool-host/             schemas, autorização e execução de tools
  verification/          Git evidence, gates, no-change e artifacts
  evaluation/            judge, self-review, scoring e revisões
  persistence/           transações, leases, migrations e replay
  supervisor/            workers, filhos, parallel e watchdog
  telemetry/             eventos, usage, logs, aggregation e redaction
  git/                   branches, worktrees, commits, PRs e checkpoints
  sandbox/               process/docker/podman e policies
  tui/                   SolidJS/OpenTUI, view models, popups e temas
  localization/          mensagens determinísticas do produto

third_party/
  opencode/
    LICENSE
    UPSTREAM.md
    copied-files.md
    patches.md
```

## Direção de dependências

```text
commands ──► orchestration ──► ports de domínio
                                  ▲
                                  │ implementações
          providers/tools/persistence/git/evaluation/telemetry
```

Restrições:

- provider não importa PRD, state store, Git ou supervisor;
- TUI não importa implementações concretas de provider;
- tools não importam a máquina de conclusão;
- persistence armazena eventos/entidades, mas não decide política;
- evaluation produz avaliação, não transição;
- commands e orchestration são os únicos lugares que aplicam precedência e política.

## Processos

```text
ralph client/TUI
      │ IPC ou execução local
      ▼
supervisor autoritativo
 ├── executor worker
 ├── judge worker
 ├── gate/tool subprocesses
 └── child Ralph supervisors/workers
```

- Trabalho potencialmente bloqueante ocorre em workers/subprocessos.
- O supervisor mantém heartbeats, leases e cancelamento.
- A TUI pode ser fechada e reanexada.
- Se todo o processo for encerrado, o ledger permite retomada.
- Cada worker recebe capability token/escopo do run e não acessa outras tarefas por acidente.

## Portas principais

```typescript
interface ModelDriver {
  listModels(): Promise<ModelInfo[]>
  invoke(request: ModelRequest, sink: ModelEventSink): Promise<ModelResult>
  cancel(callId: string): Promise<void>
}

interface CredentialDriver {
  methods(providerId: string): Promise<AuthMethod[]>
  connect(request: ConnectRequest): Promise<CredentialRef>
  resolve(ref: CredentialRef): Promise<ResolvedCredential>
  revoke(ref: CredentialRef): Promise<void>
}

interface ToolHost {
  materialize(policy: ToolPolicy): Promise<ToolDefinition[]>
  authorize(call: ToolCall, context: ToolContext): Promise<Authorization>
  execute(call: ToolCall, context: ToolContext): Promise<ToolSettlement>
}

interface Evaluator {
  evaluate(bundle: EvidenceBundle, profile: EvaluationProfile): Promise<JudgeAssessment>
}
```

Essas interfaces são ilustrativas; `docs/17-*` define os contratos normativos.

## Fluxo de uma tarefa

1. Resolver workspace e lock.
2. Validar PRD/graph recursivamente.
3. Localizar run retomável ou criar run.
4. Selecionar tarefa elegível.
5. Criar tentativa e baseline de evidência.
6. Resolver perfil, provider, modelo, credencial e capabilities.
7. Montar contexto e tool policy.
8. Iniciar worker e consumir eventos normalizados.
9. Autorizar/executar tool calls.
10. Finalizar chamada do modelo dentro dos limites.
11. Coletar Git diff, arquivos, artifacts e output.
12. Aplicar no-change e gates.
13. Invocar avaliação configurada.
14. Se necessário e permitido, criar nova revisão com feedback.
15. Transacionar conclusão, atualizar marcador e publicar evento.
16. Processar Git/integration policy.
17. Encerrar contexto/worker e selecionar próximo trabalho.

## Adaptação do OpenCode

O código transplantado fica atrás de ports do Ralph. Eventos do OpenCode são convertidos para eventos do Ralph. Componentes TUI recebem view models do Ralph. Nenhum tipo upstream deve se tornar formato persistido público sem uma camada de versão própria.
