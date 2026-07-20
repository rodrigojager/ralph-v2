import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  NpmReleaseBindingSchema,
  NpmReleasePromotionRecordSchema,
  ReleaseManifestSchema,
  ReleasePromotionRecordSchema,
  ReleaseSupportPolicySchema,
  StandaloneReleaseCandidateReceiptSchema,
} from "@ralph-next/distribution"
import {
  AttemptRecordSchema,
  CommandOperationSchema,
  CommandResultSchema,
  CompletionDecisionSchema,
  ContextAssessmentFeedbackSchema,
  ContextManifestSchema,
  DiagnosticSchema,
  DurableLeaseRecordSchema,
  EffectiveRunOptionsSchema,
  EvaluationPolicySchema,
  EvidenceBundleV2Schema,
  ExecutionReportSchema,
  GateResultSchema,
  JudgeAssessmentSchema,
  JudgeOutputSchema,
  JudgeRubricSchema,
  JudgmentCommandReportSchema,
  LeaseProbeRecordSchema,
  LegacyMigrationRollbackManifestSchema,
  RalphConfigLayerSchema,
  RalphConfigSchema,
  RecoveryContextPointerSchema,
  RecoveryDecisionObsoleteEventPayloadSchema,
  RecoveryDecisionRequiredEventPayloadSchema,
  RecoveryManifestSchema,
  RecoveryWorkspaceAcceptanceEventPayloadSchema,
  RunRecordSchema,
  TaskRecordSchema,
  VerificationCommandReportSchema,
  WatchdogEvaluationSchema,
  WatchdogObservationSchema,
  WatchdogOperationalBudgetSchema,
  WatchdogProfileSchema,
  WatchdogRecoveryDecisionSchema,
  WatchdogSnapshotSchema,
  WorkspaceIdentitySchema,
  WorkspaceStatusSchema,
} from "@ralph-next/domain"
import {
  ClassicPrdDocumentSchema,
  CompiledPrdGraphSchema,
  MarkerUpdateSchema,
  PrdDocumentSchema,
  PrdMigrationReportSchema,
} from "@ralph-next/prd"
import {
  CredentialRefSchema,
  ModelCatalogSnapshotSchema,
  ModelInfoSchema,
  ProviderEventSchema,
  ProviderInfoSchema,
  ProviderModelInputSchema,
  ProviderModelRequestSchema,
  ProviderModelResultSchema,
  ProviderToolDefinitionSchema,
  RoleProfileSchema,
  TokenUsageSchema,
} from "@ralph-next/providers"
import { EventEnvelopeConsumerSchema } from "@ralph-next/telemetry"
import { z } from "zod"

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const outputDirectory = join(projectRoot, "schemas")
const checkOnly = process.argv.includes("--check")

export const PUBLIC_SCHEMA_DEFINITIONS = [
  ["command-result", "Ralph v2 CommandResult v1", CommandResultSchema],
  ["diagnostic", "Ralph v2 Diagnostic v1", DiagnosticSchema],
  ["event-envelope", "Ralph v2 EventEnvelope consumer contract v1", EventEnvelopeConsumerSchema],
  ["ralph-config-layer", "Ralph v2 configuration layer v1", RalphConfigLayerSchema],
  ["effective-ralph-config", "Ralph v2 effective configuration v1", RalphConfigSchema],
  ["workspace-identity", "Ralph v2 workspace identity v1", WorkspaceIdentitySchema],
  ["workspace-status", "Ralph v2 workspace status v1", WorkspaceStatusSchema],
  ["prd-document", "Ralph PRD compiled document v2", PrdDocumentSchema],
  ["compiled-prd-graph", "Ralph compiled PRD graph v1", CompiledPrdGraphSchema],
  ["classic-prd-document", "Ralph classic PRD compatibility document v1", ClassicPrdDocumentSchema],
  ["prd-migration-report", "Ralph PRD migration report v1", PrdMigrationReportSchema],
  [
    "legacy-migration-rollback-manifest",
    "Ralph legacy workspace migration rollback manifest v1",
    LegacyMigrationRollbackManifestSchema,
  ],
  ["marker-update", "Ralph PRD marker update result v1", MarkerUpdateSchema],
  ["run-record", "Ralph run record v1", RunRecordSchema],
  ["task-record", "Ralph task record v1", TaskRecordSchema],
  ["attempt-record", "Ralph attempt record v1", AttemptRecordSchema],
  ["evidence-bundle", "Ralph evidence bundle v2", EvidenceBundleV2Schema],
  ["gate-result", "Ralph gate result v1", GateResultSchema],
  ["completion-decision", "Ralph completion decision v1", CompletionDecisionSchema],
  [
    "verification-command-report",
    "Ralph standalone verification report v1",
    VerificationCommandReportSchema,
  ],
  ["judgment-command-report", "Ralph standalone judgment report v1", JudgmentCommandReportSchema],
  [
    "command-operation",
    "Ralph durable verify or judge command operation v1",
    CommandOperationSchema,
  ],
  ["judge-output", "Ralph judge output v1", JudgeOutputSchema],
  ["judge-assessment", "Ralph judge assessment v1", JudgeAssessmentSchema],
  ["judge-rubric", "Ralph judge rubric v1", JudgeRubricSchema],
  ["evaluation-policy", "Ralph evaluation policy v1", EvaluationPolicySchema],
  ["effective-run-options", "Ralph effective run options v1", EffectiveRunOptionsSchema],
  [
    "context-assessment-feedback",
    "Ralph bounded assessment feedback for executor revisions v1",
    ContextAssessmentFeedbackSchema,
  ],
  ["context-manifest", "Ralph controlled context manifest v1", ContextManifestSchema],
  ["recovery-manifest", "Ralph crash recovery manifest v1", RecoveryManifestSchema],
  [
    "recovery-context-pointer",
    "Ralph bounded recovery context pointer v1",
    RecoveryContextPointerSchema,
  ],
  [
    "recovery-decision-required-event-payload",
    "Ralph explicit recovery decision request event payload v1",
    RecoveryDecisionRequiredEventPayloadSchema,
  ],
  [
    "recovery-workspace-acceptance-event-payload",
    "Ralph hash-bound workspace recovery acceptance event payload v1",
    RecoveryWorkspaceAcceptanceEventPayloadSchema,
  ],
  [
    "recovery-decision-obsolete-event-payload",
    "Ralph obsolete recovery decision event payload v1",
    RecoveryDecisionObsoleteEventPayloadSchema,
  ],
  ["durable-lease-record", "Ralph durable supervisor lease record v1", DurableLeaseRecordSchema],
  ["lease-probe-record", "Ralph durable lease owner probe record v1", LeaseProbeRecordSchema],
  ["watchdog-profile", "Ralph resolved watchdog profile v1", WatchdogProfileSchema],
  ["watchdog-observation", "Ralph watchdog observation v1", WatchdogObservationSchema],
  ["watchdog-snapshot", "Ralph watchdog diagnostic snapshot v1", WatchdogSnapshotSchema],
  [
    "watchdog-operational-budget",
    "Ralph watchdog operational restart budget v1",
    WatchdogOperationalBudgetSchema,
  ],
  [
    "watchdog-recovery-decision",
    "Ralph watchdog recovery decision v1",
    WatchdogRecoveryDecisionSchema,
  ],
  ["watchdog-evaluation", "Ralph watchdog evaluation v1", WatchdogEvaluationSchema],
  ["execution-report", "Ralph execution report v1", ExecutionReportSchema],
  ["credential-ref", "Ralph provider credential reference v1", CredentialRefSchema],
  ["provider-info", "Ralph provider information v1", ProviderInfoSchema],
  ["model-info", "Ralph model information v1", ModelInfoSchema],
  ["role-profile", "Ralph executor or judge role profile v1", RoleProfileSchema],
  ["token-usage", "Ralph normalized token usage v1", TokenUsageSchema],
  ["provider-event", "Ralph normalized provider event v1", ProviderEventSchema],
  ["provider-tool-definition", "Ralph provider tool definition v1", ProviderToolDefinitionSchema],
  ["provider-model-input", "Ralph ordered provider model input v1", ProviderModelInputSchema],
  ["provider-model-request", "Ralph provider model request v1", ProviderModelRequestSchema],
  ["provider-model-result", "Ralph normalized provider model result v1", ProviderModelResultSchema],
  ["model-catalog-snapshot", "Ralph model catalog snapshot v1", ModelCatalogSnapshotSchema],
  ["release-support-policy", "Ralph release support policy v1", ReleaseSupportPolicySchema],
  ["release-manifest", "Ralph release manifest v2", ReleaseManifestSchema],
  ["release-promotion-record", "Ralph release promotion record v3", ReleasePromotionRecordSchema],
  [
    "standalone-release-candidate-receipt",
    "Ralph standalone release candidate receipt v1",
    StandaloneReleaseCandidateReceiptSchema,
  ],
  ["npm-release-binding", "Ralph npm release binding v1", NpmReleaseBindingSchema],
  [
    "npm-release-promotion-record",
    "Ralph npm release promotion record v2",
    NpmReleasePromotionRecordSchema,
  ],
] as const

export function publicSchema(
  name: string,
  title: string,
  schema: z.ZodType,
): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { target: "draft-2020-12" })
  const output: Record<string, unknown> = {
    $schema: generated.$schema,
    $id: `https://rodrigojager.github.io/ralph-v2/schemas/v2/${name}.schema.json`,
    title,
    ...Object.fromEntries(Object.entries(generated).filter(([key]) => key !== "$schema")),
  }
  if (name === "event-envelope") {
    output.allOf = [
      {
        if: { properties: { scope: { const: "run" } }, required: ["scope"] },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword.
        then: { required: ["runId"] },
      },
    ]
  }
  if (name === "context-manifest") {
    output.allOf = [
      {
        if: { properties: { mode: { const: "wiggum" } }, required: ["mode"] },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword.
        then: { required: ["fullPrd"] },
      },
      {
        if: { required: ["revisionFeedback"] },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword.
        then: { required: ["previousAssessmentRef"] },
      },
    ]
  }
  return output
}

export async function publicSchemaMismatches(directory: string): Promise<string[]> {
  const mismatches: string[] = []
  const expectedFiles = new Set(PUBLIC_SCHEMA_DEFINITIONS.map(([name]) => `${name}.schema.json`))
  for (const file of await readdir(directory)) {
    if (file.endsWith(".schema.json") && !expectedFiles.has(file)) {
      mismatches.push(join(directory, file))
    }
  }
  for (const [name, title, runtimeSchema] of PUBLIC_SCHEMA_DEFINITIONS) {
    const path = join(directory, `${name}.schema.json`)
    const expected = publicSchema(name, title, runtimeSchema)
    try {
      const existing: unknown = JSON.parse(await readFile(path, "utf8"))
      if (JSON.stringify(existing) !== JSON.stringify(expected)) mismatches.push(path)
    } catch {
      mismatches.push(path)
    }
  }
  return mismatches
}

async function main(): Promise<void> {
  await mkdir(outputDirectory, { recursive: true })
  if (checkOnly) {
    const mismatches = await publicSchemaMismatches(outputDirectory)
    if (mismatches.length > 0) {
      throw new Error(
        `Generated JSON Schemas are missing or stale:\n${mismatches.map((path) => `- ${path}`).join("\n")}\nRun bun run schemas:generate.`,
      )
    }
  } else {
    for (const [name, title, runtimeSchema] of PUBLIC_SCHEMA_DEFINITIONS) {
      const path = join(outputDirectory, `${name}.schema.json`)
      const expected = publicSchema(name, title, runtimeSchema)
      await writeFile(path, `${JSON.stringify(expected, null, 2)}\n`, "utf8")
    }
  }

  console.log(
    checkOnly
      ? `Validated ${PUBLIC_SCHEMA_DEFINITIONS.length} generated JSON Schemas.`
      : `Generated ${PUBLIC_SCHEMA_DEFINITIONS.length} JSON Schemas in ${outputDirectory}.`,
  )
}

if (import.meta.main) await main()
