# 17 — Contratos e schemas normativos

## Convenções

Os tipos abaixo são a especificação conceitual inicial. A implementação deve materializá-los em schemas runtime (por exemplo Standard Schema/Zod/Valibot ou equivalente compatível com o stack escolhido), gerar JSON Schema onde houver interface pública e manter migrations. TypeScript está ilustrando estrutura, não autorizando `as` casts sem validação.

Regras comuns:

- IDs são strings opacas/UUID/ULID conforme tipo; task/document IDs humanos têm slug separado;
- timestamps são RFC 3339 UTC;
- durations de config são strings parseadas e persistidas também em ms efetivos;
- enums são fechados por schema version;
- unknown fields são rejeitados em config normativo e preservados somente em namespaces de extensão;
- secrets são sempre refs;
- paths persistidos relativos ao workspace, salvo canonical diagnostic separado.

## PRD compilado

```typescript
type PrdDocument = {
  schemaVersion: 2
  id: string
  title: string
  kind: "root" | "child"
  file: string
  workspace: string
  contentHash: string
  definitionHash: string
  parent?: { prd: string; task: string }
  defaults: TaskDefaults
  sharedContext: MarkdownContent
  tasks: PrdTask[]
  sourceMap: Record<string, TaskSourceLocation>
  metadata?: Record<string, unknown>
}

type TaskStatusMarker = "pending" | "active" | "completed"
type EvidenceMode =
  | "criteria"
  | "change-only"
  | "artifact"
  | "criteria+artifact"
  | "change+artifact"

type PrdTask = {
  id: string
  taskSpecHash: string
  title: string
  status: TaskStatusMarker
  result: MarkdownContent
  dependencies: string[]
  criteria: Criterion[]
  verification: VerificationSpec[]
  boundaries: MarkdownContent[]
  evidenceMode: EvidenceMode
  subPrd?: string
  parallelGroup?: string
  profiles?: { executor?: string; judge?: string }
  budget?: TaskBudget
  notes?: MarkdownContent[]
}

type Criterion = {
  id: string
  text: MarkdownContent
  weight?: number
  blocking?: boolean
}

type MarkdownContent = {
  markdown: string
  text: string
  ast: SanitizedMarkdownNode[]
}

type TaskDefaults = {
  executorProfile?: string
  judgeProfile?: string
  evidenceMode?: EvidenceMode
  budget?: TaskBudget
}

type TaskBudget = {
  maxModelCallsPerAttempt?: number
  maxToolCallsPerModelCall?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  maxReasoningTokens?: number
  maxTotalTokens?: number
  maxCost?: { amount: number; currency: string }
  taskTimeout?: { source: string; milliseconds: number }
  maxRevisionAttempts?: number
}

type VerificationCategory =
  | "instruction" | "command" | "test" | "lint" | "typecheck" | "build"
  | "file" | "artifact" | "security" | "plugin"
type VerificationSkipPolicy = "required" | "optional" | "allowed-to-skip" | "never-run"

type VerificationSpec =
  | { type: "instruction"; id: string; text: MarkdownContent; category: "instruction"; skipPolicy: "never-run"; blocking: false }
  | { type: "command"; id: string; command: CommandSpec; category: "command" | "test" | "lint" | "typecheck" | "build" | "security"; skipPolicy: VerificationSkipPolicy; blocking: boolean }
  | { type: "file"; id: string; path: string; expectation: FileExpectation; category: "file"; skipPolicy: VerificationSkipPolicy; blocking: boolean }
  | { type: "artifact"; id: string; artifactId: string; path: string; schema?: string; category: "artifact"; skipPolicy: VerificationSkipPolicy; blocking: boolean }
  | { type: "plugin"; id: string; plugin: string; input: unknown; category: "plugin"; skipPolicy: VerificationSkipPolicy; blocking: boolean }

type TaskSourceLocation = {
  file: string
  taskStart: { line: number; column: number; offset: number }
  marker: { line: number; column: number; offset: number; length: 3 }
  taskEnd: { line: number; column: number; offset: number }
}
```

Os limites de tokens e custo são cumulativos para a task no mesmo run: calls,
fallbacks, iterações Wiggum e attempts de revisão consomem o mesmo saldo. Os
qualificadores explícitos de `maxModelCallsPerAttempt` e
`maxToolCallsPerModelCall` mantêm seus escopos próprios.

`MarkdownContent` preserva o fragmento original, texto normalizado e uma AST sanitizada própria do contrato; não expõe nós executáveis nem executa HTML. `instruction` é deliberadamente diferente de `command`: prosa humana e inline code continuam instruções contextuais `never-run`, não bloqueantes e sem metadata de execução ou vínculo de critério; só uma declaração estrutural completa pode produzir `CommandSpec`. A pipeline normal não planeja, despacha nem contabiliza instructions. Isso impede o compilador de adivinhar argv/shell ou transformar orientação humana em gate indisponível.

`TaskSourceLocation.offset` é offset de byte UTF-8, zero-based. `taskStart` é inclusivo, `taskEnd` é exclusivo, `marker.offset` aponta para `[` e o byte mutável fica em `marker.offset + 1`. Linha e coluna são 1-based. Hashes cobrem os bytes originais, incluindo BOM e CRLF.

`sharedContext` contém o Markdown entre o fim do frontmatter e o início do heading `## Vertical slices`; contexto ausente é um `MarkdownContent` vazio, não `undefined`. Conteúdo posterior à seção normativa não entra automaticamente no contexto oficial.

`TaskRef` é `{ documentId, taskId, taskSpecHash }`. `CompiledPrdGraph` possui `schemaVersion: 1`, root/documentos por ID, referências portáveis, dependency/child edges com `TaskRef`, ordem topológica expandida, tarefas elegíveis, grupos paralelos, diagnostics, `definitionHash` e `graphHash`.

`taskSpecHash` é namespaced por document/task ID e cobre a especificação efetiva sem status/source position. O `definitionHash` do documento/graph inclui shared context, defaults materializados, parent links, task specs, edges, ordem e grupos, mas exclui markers/status, content hashes, source positions, eligible tasks e paths absolutos da máquina. `graphHash` é o revision hash: inclui content hashes, status, elegibilidade e os demais fatos compilados da revisão. Portanto uma troca isolada de marker conserva os hashes semânticos e altera o revision hash.

## Configuração e precedência

```typescript
type RalphConfig = {
  schemaVersion: 1
  defaults: {
    mode: RunMode
    executorProfile: string
    judgeProfile?: string
    ui: "auto" | "tui" | "plain" | "none"
    lang: string
  }
  profiles: Record<string, RoleProfile>
  run: RunDefaults
  evaluation: EvaluationConfig
  watchdog: WatchdogProfile
  parallel: ParallelConfig
  gates: Record<string, GateDefinition>
  tui: TuiConfig
  git: GitConfig
  sandbox: SandboxConfig
  security: SecurityProfile
  telemetry: TelemetryConfig
  extensions?: Record<string, unknown>
}

type EffectiveValue<T> = {
  value: T
  source: "builtin" | "global" | "workspace" | "env" | "profile" | "prd" | "task" | "cli"
  sourceRef?: string
}
```

Todo run salva `EffectiveRunOptions` com cada valor e origem, redigindo refs sensíveis. O snapshot torna-se imutável quando o run é persistido e alimenta `config explain` e o popup/resumo read-only de attach/replay. A TUI mutável da S08 edita um draft antes da criação do run ou salva defaults global/workspace para runs futuros; ela não reescreve retroativamente esse record. Uma recuperação operacional explicitamente comandada é persistida como evento/record adicional, sem mudar o snapshot original.

Overrides de credential e variant são tri-state: campo ausente preserva o perfil, string substitui e
`null` limpa. `executorParameters` e `judgeParameters` são mapas completos de replacement; `{}`
limpa. Essa distinção faz parte do hash/proveniência das opções efetivas e evita herança acidental
ao trocar provider/model.

O snapshot efetivo inclui também `securityMode`, `headlessAsk`, `toolRules`,
`allowedCommands`, `readPaths`, `writePaths` e `allowShell`, todos com
proveniência. Regras CLI sobrepõem a decisão da mesma tool; listas de commands
e scopes são uniões canônicas. A mesma tool não pode receber decisões CLI
conflitantes. Paths são scopes relativos ao workspace e `headlessAsk` torna
`ask` determinístico quando não existe aprovador interativo.

Ele inclui ainda `telemetryPolicy` com `persist_raw_output`, `event_retention` e
`redact`, incluindo origem. O runtime usa esse valor congelado para executor,
judge, tools, processos filhos, raw e retenção; attach/replay não adota defaults
editados depois. O campo é opcional apenas na leitura de ledgers anteriores à sua
introdução: nesses snapshots, o fallback é exatamente o default builtin histórico
e a projeção original mantém seu hash v1.

## Provider, modelo e credencial

```typescript
type RoleProfile = {
  id: string
  role: "executor" | "judge"
  backend: "embedded" | "external-cli"
  provider: string
  model: string
  credential?: CredentialRef
  variant?: string
  parameters: Record<string, unknown>
  requirements: ModelRequirements
  fallbackProfiles: string[]
  limits: ModelLimits
  externalCli?: {
    executable: string
    args: string[]
    cwd: string
    environmentRefs: Record<string, `env:${string}`>
    inputMode: "stdin-json"
    adapter: "protocol" | "known-output" | "generic"
    adapterId?: string
    capabilities: {
      streaming: boolean
      toolCalling: "ralph" | "internal" | "unavailable"
      cancellation: boolean
      usage: "reported" | "estimated" | "unavailable"
    }
    mutationMode: "read-only" | "workspace"
    timeoutMs: number
    outputLimitBytes: number
  }
}

type CredentialRef = {
  id: string
  provider: string
  method: "api-key" | "environment" | "oauth-browser" | "device-code" |
    "subscription-session" | "existing-session" | "external-cli"
  store: "os-keychain" | "secret-provider" | "encrypted-file" | "environment" | "insecure-file"
  locator: string
  label: string
  accountHint?: string
  expiresAt?: string
}

type ModelInfo = {
  provider: string
  id: string
  name: string
  family?: string
  status: "available" | "unavailable" | "unknown" | "deprecated"
  capabilities: {
    input: Array<"text" | "image" | "file">
    tools: boolean
    toolStreaming: boolean
    reasoning: boolean
    structuredOutput: boolean
    usage: Array<"input" | "output" | "reasoning" | "cache-read" | "cache-write" | "cost">
  }
  limits: { context?: number; output?: number }
  variants: ModelVariant[]
  price?: PriceSnapshot
  access?: Array<"api" | "subscription">
  catalogSource: string
  catalogUpdatedAt: string
}
```

`externalCli` é obrigatório somente para `backend: "external-cli"` e proibido
para `embedded`. `known-output` exige `adapterId`; outros adapters o proíbem.
O config humano usa o mesmo contrato em `snake_case`. Referências de ambiente
carregam apenas `env:<NAME>`, nunca o valor resolvido.

Na implementação S05 do transporte v1, o subconjunto executável é mais estrito:
`streaming=false`, `usage=unavailable` e `mutationMode=read-only`. Declarações futuras fora desse
subconjunto continuam representáveis para evolução de schema, mas falham fechadas no dry-run e na
execução até existir protocolo versionado de streaming/usage ou sandbox com reconciliação.

O resolver recebe também `workspaceId` e `controlRoot` fornecidos pelo comando. `workspaceRoot`
pode ser um worktree isolado, enquanto `controlRoot` identifica o workspace que contém config,
ledger e artifacts. Esses campos não são escolhidos pelo provider. Na execução real, o CLI envolve
os backends S05 em workers tipados e envia um `WorkerProfileSnapshot` com role, backend, provider,
model, variant, credential ref e hash canônico da configuração efetiva. O worker recalcula esse
hash antes de resolver o backend; mismatch falha antes da chamada.

O protocolo diferencia `executor-model.execute`, `judge.evaluate`, `tool.execute`, `gate.execute`
e `git-integration.execute`. Requests carregam escopo workspace/run/attempt, deadline, paths e
comandos exatos; results são vinculados novamente ao request. O worker pode chamar apenas RPCs
parent específicos do papel e não pode devolver resultado terminal enquanto uma dessas chamadas
estiver pendente. Ledger, marker e funções de transição nunca atravessam essa fronteira.

Perfis embedded `openai` e `openrouter` são executáveis para executor e judge. OpenRouter aceita
somente API/environment credential; assinatura ChatGPT continua exclusiva de OpenAI. Qualquer
provider sem driver embedded auditado falha com `providerUnavailable`. CLI externo continua sendo
um backend explícito, com fingerprint de executável/hash/argv/cwd/env; fallback que introduziria um
segundo CLI não autorizado falha fechado até ser selecionado explicitamente.

Limites de usage declarados pela task e pelo perfil executor são combinados pelo menor valor para
input, output, reasoning, total e custo. Dois limites de custo só são comparáveis quando usam a
mesma moeda. Cada turno real de provider ou processo é reservado antes de começar e conta mesmo
quando falha. Se qualquer limite de token/custo estiver ativo e o backend declarar
`usage=unavailable`, a execução falha fechada como limite não verificável em vez de assumir consumo
zero; limites determinísticos de calls, tools, bytes e tempo permanecem aplicáveis.

Chamadas de modelo suportam tanto `messages` legado quanto o novo `input`
ordenado, exatamente um por request. `ProviderModelInput` discrimina `message`,
`function-call` e `function-call-output`; `ProviderToolDefinition` tem campos
fechados e exige um JSON Schema de objeto com `additionalProperties: false`.
`ProviderModelResult.toolCalls` registra apenas a alegação normalizada do
provider. A autorização, execução e liquidação oficial continuam pertencendo
ao Ralph e ao ledger de tool calls.

## Run, task e tentativa

```typescript
type RunMode = "once" | "loop" | "wiggum" | "parallel"
type RunStatus =
  | "created" | "running" | "stopping" | "interrupted" | "waiting"
  | "completed" | "failed" | "cancelled"

type ResumeDiscovery = "auto" | "never" | "required"
type RunStopMode = "graceful" | "force"

type RunWorkSource =
  | { kind: "prd"; prdId: string; prdFile: string }
  | { kind: "ad-hoc"; description: string; descriptionHash: string }

type RunRecord = {
  schemaVersion: 1
  id: string
  workspaceId: string
  rootPrdId: string
  rootPrdFile: string
  source?: RunWorkSource
  definitionHash: string
  graphHash: string
  mode: RunMode
  status: RunStatus
  effectiveOptionsHash: string
  effectiveOptions: EffectiveRunOptions
  createdAt: string
  startedAt?: string
  finishedAt?: string
  stopReason?: string
  updatedAt: string
}

type TaskRuntimeStatus =
  | "pending" | "eligible" | "active" | "verifying" | "evaluating"
  | "retryable_failed" | "interrupted" | "blocked" | "rejected"
  | "cancelled" | "completed" | "completed_with_override"

type TaskRecord = {
  runId: string
  taskId: string
  documentId: string
  status: TaskRuntimeStatus
  markerContentHash: string
  activeAttemptId?: string
  completion?: CompletionDecision
  updatedAt: string
}

type AttemptRecord = {
  id: string
  runId: string
  documentId: string
  taskId: string
  ordinal: number
  phase: AttemptPhase
  status: "active" | "passed" | "failed" | "interrupted" | "rejected"
  baseline: GitBaseline
  contextManifestHash: string
  effectiveOptionsHash: string
  effectiveOptions: EffectiveRunOptions
  counters: AttemptCounters
  executorOutcome?: ExecutorOutcome
  evidenceBundleId?: string
  completionDecision?: CompletionDecision
  startedAt: string
  finishedAt?: string
  updatedAt: string
}

type AttemptCounters = {
  modelCalls: number
  toolCalls: number
  wiggumIterations: number
  executorRetries: number
  judgeTransportRetries: number
  watchdogRestarts: number
  revisionAttempts: number
  noChangeAttempts: number
  gateRuns: number
}
```

Esses records refletem deliberadamente a fronteira implementada na S03. `RunRecord` persiste tanto o hash quanto o snapshot completo de `EffectiveRunOptions`; não possui `parent` antes da supervisão pai/filho da S09 nem `eventCursor`, pois eventos e outbox têm sua própria ordenação. `TaskRecord.markerContentHash` é o hash do documento esperado na fronteira do marker e `updatedAt` participa da persistência autoritativa; `childRunId` e `claimId` permanecem fora do contrato até S09.

`AttemptRecord.ordinal` identifica a tentativa, mas ordinals especializados de revisão/retry ainda não são campos independentes: os contadores tipados distinguem model calls, tools, iterações Wiggum, retries do executor/transporte do judge, restarts do watchdog, revisões, no-change e gates. Cada tentativa vincula também o hash e o snapshot completo das opções efetivas resolvidas para aquela task; isso permite que duas tasks do mesmo run usem perfis e budgets diferentes sem perder auditabilidade. O outcome alegado pelo executor e a decisão do Ralph são opcionais porque aparecem somente depois das respectivas fases. Snapshot de perfil do executor entra com providers na S04, assessment/judge na S06 e os campos de claim/child na S09; a S03 não antecipa esses contratos.

### Schemas públicos declarados para geração

As slices declaram os contratos abaixo diretamente dos validators runtime indicados. Quando
materializados, os arquivos em `schemas/` são a forma estrutural precisa e versionada — incluindo
requiredness, enums, limites, objetos fechados e invariantes representáveis em JSON Schema — e
`scripts/generate-schemas.ts --check` impede divergência em relação à fonte Zod. A tabela é o
catálogo fonte completo de 59 outputs, não uma afirmação de que todos já existem: o checkout atual
contém 37 e mantém 22 pendentes sob o embargo executável descrito ao fim desta seção.

| Arquivo público | Validator-fonte | Finalidade |
| --- | --- | --- |
| `run-record.schema.json` | `RunRecordSchema` | Identidade semântica/de revisão, modo, status, opções efetivas completas e timestamps do run. |
| `task-record.schema.json` | `TaskRecordSchema` | Estado autoritativo, hash do marker/documento, tentativa ativa, completion e timestamps de uma task. |
| `attempt-record.schema.json` | `AttemptRecordSchema` | Fase, baseline, contexto, contadores e outcome/decisão opcionais de uma tentativa. |
| `effective-run-options.schema.json` | `EffectiveRunOptionsSchema` | Opções efetivas, origem de cada valor, normalização auditável de no-change e hash do snapshot. |
| `context-assessment-feedback.schema.json` | `ContextAssessmentFeedbackSchema` | Projeção bounded e sem profile/credential do parecer que causou uma revisão, vinculada ao assessment/evidence de origem. |
| `context-manifest.schema.json` | `ContextManifestSchema` | Contexto controlado e hashado entregue ao backend; `wiggum` exige referência e hash do PRD completo verificado. |
| `recovery-manifest.schema.json` | `RecoveryManifestSchema` | Estado de recuperação vinculado a run/task/attempt, baselines, diff, arquivos não rastreados, chamadas unsettled e ações disponíveis. |
| `recovery-context-pointer.schema.json` | `RecoveryContextPointerSchema` | Referência bounded e autenticada ao manifesto de recuperação incluído no contexto do executor. |
| `recovery-decision-required-event-payload.schema.json` | `RecoveryDecisionRequiredEventPayloadSchema` | Pedido fail-closed vinculado ao manifesto imutável e aos hashes esperado, observado e baseline da task. |
| `recovery-workspace-acceptance-event-payload.schema.json` | `RecoveryWorkspaceAcceptanceEventPayloadSchema` | Aceitação CLI de uso único ligada ao event anterior e aos manifestos bloqueado/recapturado antes da execução. |
| `recovery-decision-obsolete-event-payload.schema.json` | `RecoveryDecisionObsoleteEventPayloadSchema` | Encerramento auditável de uma decisão cuja divergência deixou de existir antes da retomada. |
| `durable-lease-record.schema.json` | `DurableLeaseRecordSchema` | Lease autoritativo com identidade real do processo, capability hash, expiração, grace e revisão CAS. |
| `lease-probe-record.schema.json` | `LeaseProbeRecordSchema` | Evidência imutável dos probes usados antes de considerar um owner expirado ou reciclado. |
| `watchdog-profile.schema.json` | `WatchdogProfileSchema` | Perfil runtime multi-sinal já convertido para milissegundos, incluindo overrides por fase. |
| `watchdog-observation.schema.json` | `WatchdogObservationSchema` | Amostra monotônica de heartbeat, progresso, processo, provider, child, settlement e deadlines. |
| `watchdog-snapshot.schema.json` | `WatchdogSnapshotSchema` | Estado derivado, quorum, confirmações e diagnóstico completo de cada probe. |
| `watchdog-operational-budget.schema.json` | `WatchdogOperationalBudgetSchema` | Contador operacional de restarts separado de revisão do judge. |
| `watchdog-recovery-decision.schema.json` | `WatchdogRecoveryDecisionSchema` | Ação command-owned com cancelamento gracioso, eventual kill, preservação de task/diff e consumo de budget. |
| `watchdog-evaluation.schema.json` | `WatchdogEvaluationSchema` | Binding entre perfil efetivo, observação, snapshot, decisão, próximo budget e diagnósticos. |
| `evidence-bundle.schema.json` | `EvidenceBundleV2Schema` | Evidências determinísticas atribuídas a document/task/attempt. |
| `gate-result.schema.json` | `GateResultSchema` | Resultado explícito de gate, inclusive skips e indisponibilidade sem mascará-los como pass. |
| `completion-decision.schema.json` | `CompletionDecisionSchema` | Decisão da policy Ralph; output do executor nunca substitui este contrato. |
| `verification-command-report.schema.json` | `VerificationCommandReportSchema` | Evidence nova, receipt, decisão e fronteiras imutáveis de uma operação standalone `verify`. |
| `judgment-command-report.schema.json` | `JudgmentCommandReportSchema` | Assessment integral, policy, decisão, refs e estabilidade de uma operação standalone `judge`. |
| `command-operation.schema.json` | `CommandOperationSchema` | Request hash-bound e lifecycle durável discriminado de `verify|judge`. |
| `execution-report.schema.json` | `ExecutionReportSchema` | Report versionado do run com tarefas, contadores separados, razões e hashes efetivos. |
| `credential-ref.schema.json` | `CredentialRefSchema` | Referência metadata-only a uma credencial; o valor secreto nunca integra o schema público. |
| `provider-info.schema.json` | `ProviderInfoSchema` | Identidade, disponibilidade, access e métodos de autenticação anunciados por um provider. |
| `model-info.schema.json` | `ModelInfoSchema` | Capabilities, limites, variantes, access, origem do catálogo e snapshot de preço aplicável. |
| `role-profile.schema.json` | `RoleProfileSchema` | Perfil materializado e independente de executor ou judge com credencial por referência e fallbacks explícitos. |
| `token-usage.schema.json` | `TokenUsageSchema` | Usage normalizado com fonte e semântica delta/cumulativa/final, incluindo indisponibilidade honesta. |
| `provider-event.schema.json` | `ProviderEventSchema` | Evento normalizado e ordenado de texto, reasoning, tool, warning, erro, usage ou conclusão. |
| `provider-tool-definition.schema.json` | `ProviderToolDefinitionSchema` | Definição fechada de tool e JSON Schema estrito de entrada. |
| `provider-model-input.schema.json` | `ProviderModelInputSchema` | União discriminada e ordenável de message, function call e function output. |
| `provider-model-request.schema.json` | `ProviderModelRequestSchema` | Request normalizado com input ordenado ou messages legado e definições de tools. |
| `provider-model-result.schema.json` | `ProviderModelResultSchema` | Resultado final normalizado de uma chamada de modelo. |
| `model-catalog-snapshot.schema.json` | `ModelCatalogSnapshotSchema` | Snapshot validado e content-addressed do catálogo usado para resolução. |
| `judge-output.schema.json` | `JudgeOutputSchema` | Resposta estruturada ainda não autoritativa do judge, com score e parecer completos. |
| `judge-assessment.schema.json` | `JudgeAssessmentSchema` | Assessment persistido e vinculado a perfil, evidence bundle e raw response redigida. |
| `judge-rubric.schema.json` | `JudgeRubricSchema` | Rubrica fechada, ponderação e critérios obrigatórios aplicados pela policy Ralph. |
| `evaluation-policy.schema.json` | `EvaluationPolicySchema` | Threshold, severidades, revisões e comportamento explícito para indisponibilidade/exaustão. |

```typescript
type ExecutionReportCounters = {
  tasksSelected: number
  tasksCompleted: number
  tasksFailed: number
  tasksBlocked: number
  attempts: number
  modelCalls: number
  toolCalls: number
  wiggumIterations: number
  executorRetries: number
  judgeTransportRetries: number
  watchdogRestarts: number
  revisionAttempts: number
  gateRuns: number
  noChangeAttempts: number
}

type TaskExecutionReport = {
  taskId: string
  documentId: string
  status: TaskRuntimeStatus
  attemptIds: string[]
  completion?: CompletionDecision
  executorOutcome?: ExecutorOutcome
  markerUpdated?: boolean
}

type ExecutionReport = {
  schemaVersion: 1
  id: string
  runId: string
  rootPrdId: string
  rootPrdFile: string
  source?: RunWorkSource
  definitionHash: string
  graphHash: string
  mode: RunMode
  status: RunStatus
  effectiveOptionsHash: string
  effectiveOptions: EffectiveRunOptions
  tasks: TaskExecutionReport[]
  counters: ExecutionReportCounters
  reasons: string[]
  createdAt: string
  startedAt?: string
  finishedAt?: string
  contentHash: string
}
```

`EffectiveRunOptions`, `ContextManifest` e `ExecutionReport` são interfaces externas/persistidas da S03, não detalhes internos do orchestrator. Seus hashes usam serialização canônica; refs sensíveis permanecem redigidas. `once`, `loop` e `wiggum` produzem os mesmos contratos, alterando apenas modo, limites e conteúdo autorizado do contexto.

`ExecutionReport` inclui `rootPrdId`, `rootPrdFile`, `source`, `definitionHash`, `graphHash`, `effectiveOptionsHash` e o `EffectiveRunOptions` completo, além de tasks, razões, timestamps e `contentHash`. `source=ad-hoc` preserva a descrição/hash necessários para resume e `TaskExecutionReport.markerUpdated=false` explicita que a conclusão foi somente no ledger. Seus counters são campos separados para tasks selecionadas/concluídas/falhas/bloqueadas, attempts, model calls, tool calls, iterações Wiggum, retries do executor, retries de transporte do judge, restarts do watchdog, revisões, gates e no-change; uma categoria nunca é inferida somando outra.

`status run` não mantém cópias permissivas desses records. A projeção pública carrega run, tasks, attempts e report validados pelos mesmos `RunRecordSchema`, `TaskRecordSchema`, `AttemptRecordSchema` e `ExecutionReportSchema` usados na persistência; apenas `progress` é uma projeção derivada e, quando nenhuma run existe, os records retornam vazios/nulos de forma explícita.

## Tool e command

```typescript
type ContextResource = {
  ref: string
  kind: "verification" | "full-prd" | "assessment"
  mediaType: "application/json" | "text/markdown"
  encoding: "utf-8"
  content: string
  contentHash: string
  includedHash: string
  originalBytes: number
  includedBytes: number
  truncated: boolean
}

type ContextAssessmentFeedback = {
  schemaVersion: 1
  sourceAssessmentRef: string
  sourceAssessmentId: string
  sourceEvidenceBundleId: string
  sourceKind: "external" | "self"
  score: number
  threshold: number
  summary: string
  adequate: string[]
  problems: JudgeFinding[]
  missingEvidence: string[]
  recommendations: string[]
  criterionScores: Array<{ criterion: string; score: number; rationale?: string }>
}

type ContextAssessmentPointer = {
  kind: "assessment"
  ref: string
  sourceAssessmentRef: string
  sourceAssessmentId: string
  sourceEvidenceBundleId: string
  contentHash: string
  includedHash: string
  score: number
  threshold: number
  truncated: boolean
}

type ContextTruncation = {
  field: string
  reason: "field-limit" | "total-budget" | "field-and-total-limit" | "item-limit"
  originalHash: string
  originalBytes?: number
  includedBytes?: number
  originalCount?: number
  includedCount?: number
}

type ContextManifestBundle = {
  manifest: ContextManifest
  resources: readonly ContextResource[]
  truncations: readonly ContextTruncation[]
  canonicalJson: string
}

type ExecutionRequest = {
  runId: string
  documentId: string
  taskId: string
  attemptId: string
  modelCallId: string
  callOrdinal: number
  workspaceRoot: string
  contextManifest: ContextManifest
  contextBundle: ContextManifestBundle
  task: PrdTask
  protectedPaths: readonly string[]
  deadlineAt?: string
}

type ModelCallRecord = {
  schemaVersion: 1
  id: string
  attemptId: string
  ordinal: number
  status: "started" | "succeeded" | "failed" | "cancelled" | "interrupted"
  requestHash: string
  contextManifestHash: string
  outcome?: ExecutorOutcome
  startedAt: string
  finishedAt?: string
  updatedAt: string
}

type ToolCallRecord = {
  schemaVersion: 1
  id: string
  attemptId: string
  modelCallId: string
  providerToolCallId: string
  tool: string
  argumentsHash: string
  argumentsRedacted: unknown
  idempotencyKey: string
  risk: "read" | "write" | "process" | "network" | "external-effect" | "destructive"
  authorization?: ToolAuthorization
  status: "requested" | "authorized" | "started" | "settled" | "unsettled"
  effects: ToolEffect[]
  settlement?: ToolSettlement
  recovery: "safe-to-retry" | "reconcile-by-precondition" | "effect-confirmed" |
    "effect-absent" | "unknown-external-effect" | "manual-review"
  requestedAt: string
  startedAt?: string
  settledAt?: string
  updatedAt: string
}

type ToolAuthorization = {
  schemaVersion: 1
  requestId: string
  requestHash: string
  action: "allow" | "deny" | "ask"
  reason: string
  ruleId?: string
  auditedOverride: boolean
  decidedAt: string
}

type ToolEffect = {
  path?: string
  kind: "read" | "created" | "modified" | "process" | "artifact"
  beforeSha256?: string | null
  afterSha256?: string | null
  ref?: string
}

type ToolSettlement = {
  schemaVersion: 1
  toolCallId: string
  outcome: "success" | "nonzero" | "denied" | "invalid" | "error" |
    "timeout" | "cancelled" | "unsettled"
  content: unknown
  outputRefs: string[]
  effects: ToolEffect[]
  durationMs: number
  retryable: boolean
  recovery: ToolCallRecord["recovery"]
  reason?: string
  settledAt: string
}

type CommandSpec = {
  executable: string
  args: string[]
  cwd?: string
  environmentRefs?: Record<string, string>
  shell?: false | { kind: "powershell" | "cmd" | "sh" | "bash" | "custom"; executable?: string }
  timeoutMs: number
  successExitCodes: number[]
  outputLimitBytes: number
}
```

`ExecutionRequest.contextManifest` deve ser o mesmo manifest contido em `contextBundle`; a forma separada é conveniência tipada, não uma segunda fonte. Refs de verification/full PRD/assessment entregues ao backend resolvem em `contextBundle.resources`, com hashes do conteúdo original e incluído. Outputs de dependência podem usar paths relativos contidos no workspace; namespaces portáteis autorizados (`artifact:`, `context:`, `evidence:` e `workspace:`) precisam apontar para materialização controlada pelo orchestrator. Path absoluto oculto e leitura direta do ledger não fazem parte do contrato do backend.

Em uma revisão causada pelo judge, `ContextManifest.previousAssessmentRef` continua presente para auditoria e `ContextManifest.revisionFeedback: ContextAssessmentPointer` resolve exatamente um resource `kind: "assessment"`. Seu conteúdo valida como `ContextAssessmentFeedback`, é limitado antes dos demais campos do contexto e vincula assessment/evidence, score e threshold aos hashes original/incluído. `profileSnapshot`, credential refs, raw response e timestamps do provider não entram nessa projeção. O executor recebe o resource pelo contexto governado; nenhuma tool ganha autorização para ler `.ralph`.

Criar um `ModelCallRecord` exige attempt ativa e o próximo `ordinal`, incrementa `AttemptCounters.modelCalls` e persiste o evento/outbox na mesma transação. O `requestHash` é um SHA-256 do request materializado; `outcome` só existe em uma chamada `succeeded` e continua sendo uma alegação tipada do executor, não autorização de completion.

Uma `ToolCallRecord` é reservada em `requested` antes de qualquer efeito. A autorização é vinculada
ao hash do request; somente `allow` pode avançar para `started`. Uma call iniciada sem settlement
durável vira `unsettled` com classificação de recovery, e não é repetida automaticamente quando o
efeito pode ter ocorrido. O settlement e seus effects alimentam evidência, mas não possuem API para
alterar task, marker ou completion.

String shell é proibida no contrato principal. Em `process.exec`, shell usa `kind`, executável
opcional e `script` em campos separados e passa por policy; a composição a transforma em uma única
projeção argv exata e hash-bound. Em `CommandSpec`, `shell` apenas declara a classificação do comando:
`executable` e `args` já precisam conter a invocação estruturada completa, sem concatenação ou
inferência a partir de Markdown.

No Markdown, `command: <CommandSpec JSON>` permanece a forma direta compatível e materializa exatamente `category: "command"`, `skipPolicy: "required"`, `blocking: true`. Metadata diferente exige wrapper explícito; nada é inferido do executable, args ou prose:

```typescript
type CommandVerificationWrapper = {
  category: "command" | "test" | "lint" | "typecheck" | "build" | "security"
  skipPolicy: "required" | "optional" | "allowed-to-skip" | "never-run"
  blocking: boolean
  command: CommandSpec
}
```

`optional` e `never-run` exigem `blocking: false`. `required` não pode ser pulada por policy comum; `allowed-to-skip` roda por default, mas admite skip explícito aplicável. As demais folhas recebem categoria derivada somente do próprio tipo e `skipPolicy: "required"`.

## Evidência, gate e judge

```typescript
type GitBaseline = {
  schemaVersion: 1
  kind: "git" | "workspace"
  revision: string | null
  branch: string | null
  dirty: boolean
  statusHash: string
  workspaceSnapshotHash: string
  capturedAt: string
}

type NoChangePolicy =
  | "require-change"
  | "allow-no-change"
  | "fail-on-no-change"
  | "retry-on-no-change"

type ChangedFile = {
  path: string
  kind: "created" | "modified" | "deleted" | "renamed"
  previousPath?: string
  contentHash?: string
  sizeBytes?: number
}

type ChangeEvidence = {
  schemaVersion: 1
  policy: NoChangePolicy
  status: "changed" | "unchanged" | "out_of_scope"
  files: ChangedFile[]
  outsideScopePaths: string[]
  reproducible: boolean
  missingContent: Array<{
    path: string
    side: "before" | "after"
    reason: string
  }>
  diffHash?: string
  diffRef?: string
  attemptDiffHash?: string
  attemptDiffRef?: string
}

type ArtifactEvidence = {
  artifactId: string
  path: string
  contentHash: string
  sizeBytes: number
  immutableRef?: string
  status: "passed" | "failed" | "not_checked"
  reason?: string
}

type EvidenceBundleV1 = {
  schemaVersion: 1
  id: string
  runId: string
  documentId: string
  taskId: string
  attemptId: string
  taskSpecHash: string
  baseline: GitBaseline
  changes: ChangeEvidence
  artifacts: ArtifactEvidence[]
  gates: GateResult[]
  executorOutcome?: ExecutorOutcome
  contextManifestHash: string
  createdAt: string
  contentHash: string
}

type EvidenceBundleV2 = {
  schemaVersion: 2
  id: string
  runId: string
  documentId: string
  taskId: string
  attemptId: string
  taskSpecHash: string
  task: ContextTask
  limits: EvidenceLimits
  baseline: GitBaseline
  changes: ChangeEvidence
  artifacts: ArtifactEvidenceV2[]
  gates: GateResult[]
  tests: Array<{ gateId: string; status: GateStatus; blocking: boolean }>
  toolCalls: EvidenceToolCall[]
  executorOutcome?: ExecutorOutcome
  context: {
    manifestHash: string
    manifestRef: string
    mode: RunMode
    previousAssessmentRef?: string
  }
  contextManifestHash: string
  profile: EvidenceProfileSnapshot
  usage: EvidenceUsage
  priorAttempts: EvidencePriorAttempt[]
  priorAssessments: EvidenceAssessmentRef[]
  security: EvidenceSecuritySnapshot
  provenance: {
    task: EvidenceSource
    changes: EvidenceSource
    artifacts: EvidenceSource
    gates: EvidenceSource
    tools: EvidenceSource
    context: EvidenceSource
    profile: EvidenceSource
    usage: EvidenceSource
    security: EvidenceSource
    assessments: EvidenceSource
  }
  truncations: EvidenceTruncation[]
  missingEvidence: MissingEvidence[]
  createdAt: string
  contentHash: string
}

type EvidenceBundle = EvidenceBundleV1 | EvidenceBundleV2

type GateResult = {
  gateId: string
  category: string
  blocking: boolean
  status: "passed" | "failed" | "timeout" | "error" | "skipped_by_cli" |
    "skipped_by_policy" | "not_applicable" | "unavailable"
  command?: CommandSpec
  exitCode?: number
  durationMs: number
  outputRefs: string[]
  stdoutBytes?: number
  stderrBytes?: number
  outputTruncated?: boolean
  rawOutputTruncated?: boolean
  reason?: string
}

type JudgeAssessment = {
  schemaVersion: 1
  id: string
  kind: "external" | "self"
  profileSnapshot: RoleProfile
  evidenceBundleId: string
  score: number
  summary: string
  adequate: string[]
  problems: JudgeFinding[]
  missingEvidence: string[]
  recommendations: string[]
  criterionScores: Array<{ criterion: string; score: number; rationale?: string }>
  confidence?: number
  rawResponseRef?: string
  createdAt: string
}

type CompletionDecision = {
  status: "passed" | "failed" | "revision_required" | "blocked" | "overridden"
  deterministicPassed: boolean
  evaluationMode: "none" | "external" | "self" | "manual"
  score?: number
  threshold?: number
  severityRulesPassed?: boolean
  evidenceBundleId: string
  assessmentId?: string
  reasons: string[]
  decidedBy: "ralph-policy"
  decidedAt: string
}

type CommandEvidenceSelection = {
  schemaVersion: 1
  workspaceId: string
  runId: string
  documentId: string
  taskId: string
  attemptId: string
  evidenceBundleId: string
  evidenceContentHash: string
  source: "execution-evidence" | "verification-evidence"
  verificationOperationId?: string
}

type CommandSafetyBoundary = {
  executorInvocation: "forbidden"
  toolCalling: "forbidden"
  taskStateMutation: "forbidden"
  prdMarkerMutation: "forbidden"
}

type VerifyCommandRequest = {
  schemaVersion: 1
  command: "verify"
  selection: CommandEvidenceSelection & { source: "execution-evidence" }
  gatePolicy: {
    skipTests: boolean
    skipLint: boolean
    skipGates: string[]
    noGates: boolean
    fast: boolean
    force: boolean
    failFast: boolean
  }
  safety: CommandSafetyBoundary
}

type JudgeCommandRequest = {
  schemaVersion: 1
  command: "judge"
  selection: CommandEvidenceSelection
  kind: "external" | "self"
  profileId: string
  policy: EvaluationPolicy
  safety: CommandSafetyBoundary
}

type VerificationCommandReport = {
  schemaVersion: 1
  id: string
  operationId: string
  command: "verify"
  selection: CommandEvidenceSelection
  status: "passed" | "failed" | "blocked" | "overridden"
  evidence: EvidenceBundleV2
  evidenceObject: { schemaVersion: 1; contentRef: string; storageHash: string; sizeBytes: number }
  decision: CompletionDecision
  workspaceStable: boolean
  controlStateStable: boolean
  gateCount: number
  executorInvoked: false
  markerUpdated: false
  startedAt: string
  finishedAt: string
  contentHash: string
}

type JudgmentCommandReport = {
  schemaVersion: 1
  id: string
  operationId: string
  command: "judge"
  selection: CommandEvidenceSelection
  status: CompletionDecision["status"]
  kind: "external" | "self"
  profileId: string
  policy: EvaluationPolicy
  assessment: JudgeAssessment
  assessmentRef: string
  assessmentStorageHash: string
  assessmentSizeBytes: number
  decision: CompletionDecision
  workspaceStable: boolean
  controlStateStable: boolean
  toolsAvailable: false
  codeMutationApplied: false
  markerUpdated: false
  startedAt: string
  finishedAt: string
  contentHash: string
}

type CommandOperation = {
  schemaVersion: 1
  id: string
  command: "verify" | "judge"
  status: "started" | "succeeded" | "failed" | "cancelled"
  request: VerifyCommandRequest | JudgeCommandRequest
  requestHash: string
  report?: VerificationCommandReport | JudgmentCommandReport
  error?: { code: string; message: string }
  startedAt: string
  finishedAt?: string
}
```

`workspaceSnapshotHash` vincula o baseline ao snapshot exato usado pelo diff; `statusHash` vincula os fatos Git observados e não substitui o snapshot. `diffHash`/`diffRef` identificam o delta cumulativo desde o baseline da task, enquanto `attemptDiffHash`/`attemptDiffRef` identificam somente a tentativa atual. As refs são portáteis e resolvem para arquivos content-addressed persistidos sob a run. `reproducible=false` enumera em `missingContent` todo lado do delta que não pôde ser retido por sensibilidade ou limite e bloqueia completion, sem arquivar bytes proibidos nem transformar a condição em erro operacional. Artifacts aprovados exigem `immutableRef`; falha de coleta vira gate interno bloqueante. Outputs brutos de command gate são content-addressed e namespaced pela tentativa, enquanto os campos de bytes/truncamento deixam explícito se a visão resumida ou a prova bruta atingiu seu limite.

O produtor S06 grava `EvidenceBundleV2`. A versão 1 permanece somente para leitura de ledgers anteriores. O v2 inclui a task compilada e seus critérios/limites, tool intents e settlements quando existirem, usage final agregada ou explicitamente indisponível, snapshot do perfil executor, binding do contexto, tentativas/assessments anteriores, política de segurança, proveniência campo a campo e avisos explícitos de truncamento ou evidência ausente. Ausência não é convertida em dado fictício.

O `contentHash` é calculado sobre a forma canônica do bundle sem o próprio hash. O objeto completo é gravado de forma atômica e imutável em uma referência content-addressed da run; o ledger guarda também a referência, o hash dos bytes armazenados e o tamanho. Leitura e completion verificam schema, binding semântico, tamanho e hash antes de aceitar a evidência. Uma repetição byte a byte é idempotente; tentar substituir o bundle de um attempt por conteúdo diferente é conflito. `ralph evidence inspect <attempt-id> --format human|json` usa essa mesma leitura verificada; JSON expõe o bundle integral e seus metadados de armazenamento, enquanto human apresenta o resumo auditável.

Score schema valida inteiro `0..100`; o judge não fornece `passed` autoritativo.

`CommandEvidenceSelection` exige `verificationOperationId` exatamente quando a fonte é
`verification-evidence`. `verify` só aceita `execution-evidence`; `judge` aceita ambas. Request e
report são discriminados por command e hashados canonicamente. Um operation terminal de sucesso
carrega exatamente um report; failed/cancelled carrega exatamente um erro. Os reports obrigam
status igual à `CompletionDecision`, binding de run/task/attempt/evidence e as constantes de
segurança acima. O report repete exatamente a seleção imutável do request; no `judge`, kind, profile,
policy, evaluation mode, assessment ID, score e threshold também precisam coincidir. Receipts
recalculam hash e tamanho dos bytes canônicos de evidence/assessment. `workspaceStable` e
`controlStateStable` registram separadamente diff de arquivos e igualdade dos records duráveis de
task/attempt; qualquer violação impede report aprovador. Nenhum desses contratos
autoriza a transição oficial de task.

Uma decisão `overridden` exige um `CompletionOverrideAudit` persistido junto de `completion_prepared`. Somente gates bloqueantes `passed` ou `skipped_by_cli` podem atravessar esse caminho, e o audit deve nomear exatamente todos os gates bloqueantes pulados. Uma decisão normal `passed` rejeita qualquer audit de override. O audit também recebe evento/outbox na mesma transação, e a decisão preparada não pode ser substituída durante o commit.

## Usage

```typescript
type UsageSource = "reported" | "derived" | "estimated" | "unavailable"

type TokenUsage = {
  input?: number
  inputNonCached?: number
  cacheRead?: number
  cacheWrite?: number
  output?: number
  reasoning?: number
  total?: number
  cost?: {
    amount: number
    currency: string
    priceSnapshotId: string
    source?: Exclude<UsageSource, "unavailable">
  }
  source: UsageSource
  semantics: "delta" | "cumulative" | "final"
  providerRawRef?: string
}

type TokenUsageAggregate = {
  executor: NormalizedUsage
  judge: NormalizedUsage
  total: NormalizedUsage
  unavailableCalls: number
  estimatedCalls: number
}
```

Aggregador guarda último snapshot por call e só aplica delta calculado. Inteiros não negativos e overflow são validados.

## Watchdog e lease

```typescript
type LeaseRecord = {
  schemaVersion: 1
  id: string
  kind: "workspace-supervisor" | "run-supervisor" | "worker"
  resourceKey: string
  workspaceId: string
  runId?: string
  ownerInstanceId: string
  workerId?: string
  pid: number
  processStartToken: string
  hostname: string
  command: string
  scope: string[]
  parentRunId?: string
  parentWorkerId?: string
  acquiredAt: string
  renewedAt: string
  expiresAt: string
  graceExpiresAt: string
  status: "active" | "released" | "stolen"
  revision: number
  releasedAt?: string
  replacedByLeaseId?: string
}

type LeaseProbeRecord = {
  schemaVersion: 1
  id: string
  leaseId: string
  observerInstanceId: string
  sequence: number
  status: "alive" | "dead" | "identity-mismatch" | "unreachable"
  expectedProcessStartToken: string
  observedProcessStartToken?: string
  observedAt: string
  reason: string
}

type WatchdogProfile = {
  enabled: boolean
  heartbeatIntervalMs: number
  heartbeatGraceMs: number
  quietAfterMs: number
  slowAfterMs: number
  suspectAfterMs: number
  hardTimeoutMs?: number
  probeIntervalMs: number
  confirmations: number
  action: "notify" | "cancel" | "restart-attempt" | "stop-run"
  maxRestarts: number
  phases?: Partial<Record<WatchdogPhase, Partial<WatchdogProfile>>>
}

type WatchdogSnapshot = {
  state: "healthy" | "quiet" | "slow" | "suspect" | "stalled" | "recovered"
  phase: WatchdogPhase
  lastControlHeartbeatAt?: string
  lastProgressAt?: string
  processAlive: "yes" | "no" | "unknown"
  providerPending: "yes" | "no" | "unknown"
  negativeConfirmations: number
  elapsedMs: number
  reasons: string[]
}
```

O lease de workspace pode nascer sem `runId` para proteger atomicamente a descoberta/criação do
run; o supervisor o vincula uma única vez assim que o run durável existe. Aquisição, renovação,
binding, liberação e tomada usam `revision` como compare-and-swap no ledger. Um owner expirado só
é substituído após `graceExpiresAt` e múltiplos probes negativos persistidos. O arquivo em
`.ralph/locks/` é somente espelho diagnóstico e nunca substitui o lease transacional.

## Progresso

```typescript
type ProgressSnapshot = {
  scope: { kind: "root" | "child" | "aggregate"; runId: string }
  completed: number
  total: number
  active: number
  pending: number
  blocked: number
  rejected: number
  ratio: number
  currentTaskId?: string
  currentPhase?: AttemptPhase
  revision: number
}

function progress(completed: number, total: number): number {
  return total === 0 ? 0 : completed / total
}
```

`completed` conta apenas task completion durable daquele escopo. UI bar recebe `availableCells` e calcula fill por floor, com caso especial 100%.

## Evento e output de comando

O `EventEnvelope` está em `docs/11-*`. Resultados JSON de comandos usam:

```typescript
type CommandResult<T> = {
  schemaVersion: 1
  ok: boolean
  command: string
  data?: T
  diagnostics: Diagnostic[]
  runId?: string
}

type Diagnostic = {
  code: string
  severity: "info" | "warning" | "error"
  message: string
  file?: string
  line?: number
  column?: number
  hint?: string
  details?: Record<string, unknown>
}
```

## Exit codes

| Código | Significado |
| --- | --- |
| `0` | comando e objetivo solicitado concluídos |
| `1` | erro operacional não classificado |
| `2` | uso/flag/config inválido |
| `3` | PRD/schema/graph inválido |
| `4` | task falhou gate/verification ou foi rejeitada |
| `5` | bloqueada/aguardando ação necessária |
| `6` | autenticação/provider/model indisponível sem fallback |
| `7` | conflito de lease/workspace/Git |
| `8` | cancelada/interrompida, retomável |
| `9` | limite/budget/timeout/watchdog esgotado |
| `10` | security/policy negou operação |

Subcommands podem acrescentar details no JSON, mas não redefinir silenciosamente estes códigos.

## Contratos de distribuição e matriz de suporte

Os validators runtime em `packages/distribution/src/{contracts,promotion,npm-release}.ts` são a fonte única para:

- `ReleaseSupportPolicySchema` v1: versão/channel e exatamente as seis entries canônicas;
- `ReleaseManifestSchema` v2: policy completa, `supportPolicySha256`, artifacts exatamente iguais às
  entries `included`, payloads, promoção e assinatura;
- `ReleasePromotionRecordSchema` v3: support binding que inclui o mesmo policy hash, exige
  R001–R079 e target evidence apenas para o subconjunto `included`;
- `StandaloneReleaseCandidateReceiptSchema` v1: receipt não publicável que liga source, policy,
  support files e payloads por target ao candidato exato produzido na primeira passagem;
- `NpmReleaseBindingSchema` v1: subject externo assinado que vincula tarball, identidade npm,
  channel/dist-tag, source e support files sem hash auto-referente;
- `NpmReleasePromotionRecordSchema` v2: receipt independente de candidato standalone, promoção base
  v3 revalidada por `assertReleasePromotionBinding` e gates npm exatos. `artifactRefs` vinculam o
  candidato; `evidenceRefs`, receipts/logs externos content-addressed. Evidence runtime é tipada e o
  install drill cobre cada OS/arquitetura promovido com versões de Bun e do package manager;
- `InstallDurabilitySchema`: `fsync-before-rename` mais directory sync `full` ou file-only
  `reduced`, sem permitir combinações contraditórias.

Cada entry de support policy é uma união discriminada: `included` exige `limitations[]` e
`not-promoted` exige `reason`. `included` é intenção de composição, não evidence. A serialização
canônica ordena chaves, preserva a ordem normativa da matrix e produz SHA-256 recalculado no
manifest, promotion binding e installer. Alterar targets, capability ou semântica exige nova versão
do schema; omitir uma linha ou declarar Windows `full` com a primitive atual é inválido.

O catálogo fonte declara 60 schemas e todos estão materializados em `schemas/`. A autoridade continua
sendo `PUBLIC_SCHEMA_DEFINITIONS` mais os validators runtime; nenhum JSON Schema é mantido
manualmente. `schemas:generate` reescreve o conjunto integral e `schemas:check` compara nomes e bytes,
falhando para arquivo ausente, extra ou stale. O catálogo foi regenerado nesta edição depois da
fixação do namespace público versionado; a prova automatizada completa permanece vinculada à fila
oculta de validação S12.

## Evolução de schema

- persisted entities e public JSON têm `schemaVersion`;
- adicionar campo opcional é minor; mudar semântica/enum obrigatório exige migration/major;
- event consumer negocia versão;
- migrations possuem backup e downgrade/rollback story quando possível;
- fixtures de versões anteriores permanecem na suíte;
- tipos upstream nunca determinam versionamento público.
