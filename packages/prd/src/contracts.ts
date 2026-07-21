import { DiagnosticSchema } from "@ralph/domain"
import { z } from "zod"

export const PRD_SCHEMA_VERSION = 2 as const
export const COMPILED_PRD_GRAPH_SCHEMA_VERSION = 1 as const

export const ContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const DefinitionHashSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const TaskSpecHashSchema = z.string().regex(/^[a-f0-9]{64}$/)

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
)

export const PrdSlugSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, "Expected a lowercase kebab-case slug")

export const TaskStatusMarkerSchema = z.enum(["pending", "active", "completed"])
export type TaskStatusMarker = z.infer<typeof TaskStatusMarkerSchema>

export const EvidenceModeSchema = z.enum([
  "criteria",
  "change-only",
  "artifact",
  "criteria+artifact",
  "change+artifact",
])
export type EvidenceMode = z.infer<typeof EvidenceModeSchema>

export const MarkdownAstNodeSchema: z.ZodType<MarkdownAstNode> = z.lazy(() =>
  z
    .object({
      type: z.enum([
        "blockquote",
        "break",
        "code",
        "delete",
        "emphasis",
        "html",
        "image",
        "inlineCode",
        "link",
        "list",
        "listItem",
        "paragraph",
        "strong",
        "text",
      ]),
      value: z.string().optional(),
      url: z.string().optional(),
      title: z.string().nullable().optional(),
      alt: z.string().nullable().optional(),
      lang: z.string().nullable().optional(),
      ordered: z.boolean().optional(),
      start: z.number().int().positive().nullable().optional(),
      checked: z.boolean().nullable().optional(),
      children: z.array(MarkdownAstNodeSchema).optional(),
    })
    .strict(),
)

export type MarkdownAstNode = {
  type:
    | "blockquote"
    | "break"
    | "code"
    | "delete"
    | "emphasis"
    | "html"
    | "image"
    | "inlineCode"
    | "link"
    | "list"
    | "listItem"
    | "paragraph"
    | "strong"
    | "text"
  value?: string | undefined
  url?: string | undefined
  title?: string | null | undefined
  alt?: string | null | undefined
  lang?: string | null | undefined
  ordered?: boolean | undefined
  start?: number | null | undefined
  checked?: boolean | null | undefined
  children?: MarkdownAstNode[] | undefined
}

export const MarkdownContentSchema = z
  .object({
    markdown: z.string(),
    text: z.string(),
    ast: z.array(MarkdownAstNodeSchema),
  })
  .strict()

export type MarkdownContent = z.infer<typeof MarkdownContentSchema>

export const DurationSchema = z
  .object({
    source: z.string().min(1),
    milliseconds: z.number().int().nonnegative(),
  })
  .strict()

export type Duration = z.infer<typeof DurationSchema>

export const TaskBudgetSchema = z
  .object({
    maxModelCallsPerAttempt: z.number().int().nonnegative().optional(),
    maxToolCallsPerModelCall: z.number().int().nonnegative().optional(),
    maxInputTokens: z.number().int().nonnegative().optional(),
    maxOutputTokens: z.number().int().nonnegative().optional(),
    maxReasoningTokens: z.number().int().nonnegative().optional(),
    maxTotalTokens: z.number().int().nonnegative().optional(),
    maxCost: z
      .object({
        amount: z.number().nonnegative(),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .strict()
      .optional(),
    taskTimeout: DurationSchema.optional(),
    maxRevisionAttempts: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((budget) => Object.keys(budget).length > 0, "Budget must contain at least one limit")

export type TaskBudget = z.infer<typeof TaskBudgetSchema>

export const TaskDefaultsSchema = z
  .object({
    executorProfile: PrdSlugSchema.optional(),
    judgeProfile: PrdSlugSchema.optional(),
    evidenceMode: EvidenceModeSchema.optional(),
    budget: TaskBudgetSchema.optional(),
  })
  .strict()

export type TaskDefaults = z.infer<typeof TaskDefaultsSchema>

export const CriterionSchema = z
  .object({
    id: z.string().min(1),
    text: MarkdownContentSchema,
    weight: z.number().positive().optional(),
    blocking: z.boolean().optional(),
  })
  .strict()

export type Criterion = z.infer<typeof CriterionSchema>

export const CommandSpecSchema = z
  .object({
    executable: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().min(1).optional(),
    environmentRefs: z.record(z.string().min(1), z.string().min(1)).optional(),
    shell: z
      .union([
        z.literal(false),
        z
          .object({
            kind: z.enum(["powershell", "cmd", "sh", "bash", "custom"]),
            executable: z.string().min(1).optional(),
          })
          .strict(),
      ])
      .optional(),
    timeoutMs: z.number().int().positive(),
    successExitCodes: z.array(z.number().int()).min(1),
    outputLimitBytes: z.number().int().positive(),
  })
  .strict()
export type CommandSpec = z.infer<typeof CommandSpecSchema>

export const VerificationCategorySchema = z.enum([
  "instruction",
  "command",
  "test",
  "lint",
  "typecheck",
  "build",
  "file",
  "schema",
  "git",
  "artifact",
  "security",
  "plugin",
])
export type VerificationCategory = z.infer<typeof VerificationCategorySchema>

export const CommandVerificationCategorySchema = z.enum([
  "command",
  "test",
  "lint",
  "typecheck",
  "build",
  "security",
])
export type CommandVerificationCategory = z.infer<typeof CommandVerificationCategorySchema>

export const VerificationSkipPolicySchema = z.enum([
  "required",
  "optional",
  "allowed-to-skip",
  "never-run",
])
export type VerificationSkipPolicy = z.infer<typeof VerificationSkipPolicySchema>

export const VerificationPlatformSchema = z.enum(["linux", "darwin", "win32"])
export type VerificationPlatform = z.infer<typeof VerificationPlatformSchema>

export const VerificationConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file-exists"), path: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("file-absent"), path: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("path-changed"),
      path: z.string().min(1),
      match: z.enum(["exact", "prefix"]).optional(),
    })
    .strict(),
])
export type VerificationCondition = z.infer<typeof VerificationConditionSchema>

export const VerificationApplicabilitySchema = z
  .object({
    platforms: z
      .array(VerificationPlatformSchema)
      .min(1)
      .refine((values) => new Set(values).size === values.length, "Platforms must be unique")
      .optional(),
    conditions: z.array(VerificationConditionSchema).min(1).optional(),
  })
  .strict()
  .refine(
    (value) => value.platforms !== undefined || value.conditions !== undefined,
    "Applicability must declare platforms and/or conditions",
  )
export type VerificationApplicability = z.infer<typeof VerificationApplicabilitySchema>

const VerificationExecutionMetadataShape = {
  attempts: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  applicability: VerificationApplicabilitySchema.optional(),
  criterionIds: z
    .array(z.string().min(1))
    .min(1)
    .refine((values) => new Set(values).size === values.length, "Criterion IDs must be unique")
    .optional(),
}

export const PluginGateIdSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*$/,
    "Expected a lowercase kebab-case plugin ID, optionally namespace-qualified with /",
  )

export const GitExpectationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("clean") }).strict(),
  z.object({ kind: z.literal("changed") }).strict(),
  z.object({ kind: z.literal("no-conflicts") }).strict(),
  z.object({ kind: z.literal("branch"), value: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("paths-within"),
      paths: z.array(z.string().min(1)).min(1),
      requireChanges: z.boolean().optional(),
    })
    .strict(),
])
export type GitExpectation = z.infer<typeof GitExpectationSchema>

export const CommandVerificationWrapperSchema = z
  .object({
    command: CommandSpecSchema,
    category: CommandVerificationCategorySchema,
    skipPolicy: VerificationSkipPolicySchema,
    blocking: z.boolean(),
    ...VerificationExecutionMetadataShape,
  })
  .strict()
  .superRefine((verification, context) => {
    if (
      (verification.skipPolicy === "optional" || verification.skipPolicy === "never-run") &&
      verification.blocking
    ) {
      context.addIssue({
        code: "custom",
        path: ["blocking"],
        message: `${verification.skipPolicy} command verification must use blocking=false`,
      })
    }
  })

export const FileExpectationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exists") }).strict(),
  z.object({ kind: z.literal("non-empty") }).strict(),
  z.object({ kind: z.literal("absent") }).strict(),
  z
    .object({
      kind: z.literal("sha256"),
      value: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z.object({ kind: z.literal("json-schema"), schema: z.string().min(1) }).strict(),
])

export const VerificationSpecSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        type: z.literal("instruction"),
        id: z.string().min(1),
        text: MarkdownContentSchema,
        category: z.literal("instruction"),
        skipPolicy: z.literal("never-run"),
        blocking: z.literal(false),
      })
      .strict(),
    z
      .object({
        type: z.literal("command"),
        id: z.string().min(1),
        command: CommandSpecSchema,
        category: CommandVerificationCategorySchema,
        skipPolicy: VerificationSkipPolicySchema,
        blocking: z.boolean(),
        ...VerificationExecutionMetadataShape,
      })
      .strict(),
    z
      .object({
        type: z.literal("file"),
        id: z.string().min(1),
        path: z.string().min(1),
        expectation: FileExpectationSchema,
        category: z.literal("file"),
        skipPolicy: VerificationSkipPolicySchema,
        blocking: z.boolean(),
        ...VerificationExecutionMetadataShape,
      })
      .strict(),
    z
      .object({
        type: z.literal("schema"),
        id: z.string().min(1),
        path: z.string().min(1),
        schema: z.string().min(1),
        category: z.literal("schema"),
        skipPolicy: VerificationSkipPolicySchema,
        blocking: z.boolean(),
        ...VerificationExecutionMetadataShape,
      })
      .strict(),
    z
      .object({
        type: z.literal("git"),
        id: z.string().min(1),
        expectation: GitExpectationSchema,
        category: z.literal("git"),
        skipPolicy: VerificationSkipPolicySchema,
        blocking: z.boolean(),
        ...VerificationExecutionMetadataShape,
      })
      .strict(),
    z
      .object({
        type: z.literal("artifact"),
        id: z.string().min(1),
        artifactId: PrdSlugSchema,
        path: z.string().min(1),
        schema: z.string().min(1).optional(),
        expectedSha256: ContentHashSchema.optional(),
        category: z.literal("artifact"),
        skipPolicy: VerificationSkipPolicySchema,
        blocking: z.boolean(),
        ...VerificationExecutionMetadataShape,
      })
      .strict(),
    z
      .object({
        type: z.literal("plugin"),
        id: z.string().min(1),
        plugin: PluginGateIdSchema,
        input: JsonValueSchema,
        category: z.literal("plugin"),
        skipPolicy: VerificationSkipPolicySchema,
        blocking: z.boolean(),
        ...VerificationExecutionMetadataShape,
      })
      .strict(),
  ])
  .superRefine((verification, context) => {
    if (
      (verification.skipPolicy === "optional" || verification.skipPolicy === "never-run") &&
      verification.blocking
    ) {
      context.addIssue({
        code: "custom",
        path: ["blocking"],
        message: `${verification.skipPolicy} verification must use blocking=false`,
      })
    }
  })

export type VerificationSpec = z.infer<typeof VerificationSpecSchema>
export type ExecutableVerificationSpec = Exclude<VerificationSpec, { type: "instruction" }>

export const SourcePointSchema = z
  .object({
    line: z.number().int().positive(),
    column: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  })
  .strict()

export const TaskSourceLocationSchema = z
  .object({
    file: z.string().min(1),
    taskStart: SourcePointSchema,
    marker: SourcePointSchema.extend({ length: z.literal(3) }).strict(),
    taskEnd: SourcePointSchema,
  })
  .strict()

export type TaskSourceLocation = z.infer<typeof TaskSourceLocationSchema>

export const PrdParentSchema = z
  .object({
    prd: z.string().min(1),
    task: PrdSlugSchema,
  })
  .strict()

export const PrdTaskSchema = z
  .object({
    id: PrdSlugSchema,
    taskSpecHash: TaskSpecHashSchema,
    title: z.string().min(1),
    status: TaskStatusMarkerSchema,
    result: MarkdownContentSchema,
    dependencies: z.array(PrdSlugSchema),
    criteria: z.array(CriterionSchema),
    verification: z.array(VerificationSpecSchema),
    boundaries: z.array(MarkdownContentSchema).min(1),
    evidenceMode: EvidenceModeSchema,
    subPrd: z.string().min(1).optional(),
    parallelGroup: PrdSlugSchema.optional(),
    profiles: z
      .object({ executor: PrdSlugSchema.optional(), judge: PrdSlugSchema.optional() })
      .strict()
      .optional(),
    budget: TaskBudgetSchema.optional(),
    notes: z.array(MarkdownContentSchema).optional(),
  })
  .strict()

export type PrdTask = z.infer<typeof PrdTaskSchema>

export const PrdDocumentSchema = z
  .object({
    schemaVersion: z.literal(PRD_SCHEMA_VERSION),
    id: PrdSlugSchema,
    title: z.string().min(1),
    kind: z.enum(["root", "child"]),
    file: z.string().min(1),
    workspace: z.string().min(1),
    contentHash: ContentHashSchema,
    definitionHash: DefinitionHashSchema,
    parent: PrdParentSchema.optional(),
    defaults: TaskDefaultsSchema,
    sharedContext: MarkdownContentSchema,
    tasks: z.array(PrdTaskSchema).min(1),
    sourceMap: z.record(PrdSlugSchema, TaskSourceLocationSchema),
    metadata: z.record(z.string(), JsonValueSchema).optional(),
  })
  .strict()
  .superRefine((document, context) => {
    if (document.kind === "child" && document.parent === undefined) {
      context.addIssue({
        code: "custom",
        path: ["parent"],
        message: "Child PRDs require a parent reference",
      })
    }
    if (document.kind === "root" && document.parent !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["parent"],
        message: "Root PRDs cannot declare a parent reference",
      })
    }
  })

export type PrdDocument = z.infer<typeof PrdDocumentSchema>

export const TaskRefSchema = z
  .object({
    documentId: PrdSlugSchema,
    taskId: PrdSlugSchema,
    taskSpecHash: TaskSpecHashSchema,
  })
  .strict()

export type TaskRef = z.infer<typeof TaskRefSchema>

export const DependencyEdgeSchema = z
  .object({
    task: TaskRefSchema,
    dependsOn: TaskRefSchema,
  })
  .strict()

export const ChildEdgeSchema = z
  .object({
    parentTask: TaskRefSchema,
    childDocument: PrdSlugSchema,
  })
  .strict()

export const ParallelGroupSchema = z
  .object({
    documentId: PrdSlugSchema,
    id: PrdSlugSchema,
    tasks: z.array(TaskRefSchema).min(1),
  })
  .strict()

export const CompiledPrdGraphSchema = z
  .object({
    schemaVersion: z.literal(COMPILED_PRD_GRAPH_SCHEMA_VERSION),
    rootDocumentId: PrdSlugSchema,
    rootFile: z.string().min(1),
    documents: z.record(PrdSlugSchema, PrdDocumentSchema),
    canonicalReferences: z.record(PrdSlugSchema, z.string().min(1)),
    dependencyEdges: z.array(DependencyEdgeSchema),
    childEdges: z.array(ChildEdgeSchema),
    topologicalOrder: z.array(TaskRefSchema),
    eligibleTasks: z.array(TaskRefSchema),
    parallelGroups: z.array(ParallelGroupSchema),
    diagnostics: z.array(DiagnosticSchema),
    definitionHash: DefinitionHashSchema,
    graphHash: ContentHashSchema,
  })
  .strict()

export type CompiledPrdGraph = z.infer<typeof CompiledPrdGraphSchema>

export const PrdFormatDetectionSchema = z.enum(["v2", "classic", "unknown"])
export type PrdFormatDetection = z.infer<typeof PrdFormatDetectionSchema>

export const MigrationNoticeSchema = z
  .object({
    code: z.string().min(1),
    severity: z.enum(["info", "warning", "error"]),
    kind: z.enum(["direct", "inferred", "promoted", "dropped", "semantic-change"]),
    source: z
      .object({
        file: z.string().min(1),
        line: z.number().int().positive().optional(),
        column: z.number().int().positive().optional(),
        field: z.string().min(1),
        value: JsonValueSchema.optional(),
      })
      .strict(),
    target: z
      .object({ field: z.string().min(1), value: JsonValueSchema.optional() })
      .strict()
      .optional(),
    reason: z.string().min(1),
  })
  .strict()

export const PrdMigrationReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.string().min(1),
    output: z.string().min(1),
    detected: z.literal("classic"),
    taskCount: z.number().int().nonnegative(),
    lossless: z.boolean(),
    notices: z.array(MigrationNoticeSchema),
  })
  .strict()

export type PrdMigrationReport = z.infer<typeof PrdMigrationReportSchema>

export const ClassicTaskStatusSchema = z.enum(["pending", "completed", "skipped-for-review"])

export const ClassicPrdTaskSchema = z
  .object({
    ordinal: z.number().int().positive(),
    text: z.string(),
    status: ClassicTaskStatusSchema,
    line: z.number().int().positive(),
    column: z.number().int().positive(),
    markerByteOffset: z.number().int().nonnegative().optional(),
    indentation: z.number().int().nonnegative(),
    id: z.string().min(1).optional(),
    group: z.string().min(1).optional(),
    dependsOnGroups: z.array(z.string().min(1)),
    acceptanceCriteria: z.array(z.string().min(1)),
    filesAllowed: z.array(z.string().min(1)),
    gates: z.array(z.string().min(1)),
    notes: z.array(z.string().min(1)),
    priority: z.string().min(1).optional(),
    complexity: z.string().min(1).optional(),
  })
  .strict()

export type ClassicPrdTask = z.infer<typeof ClassicPrdTaskSchema>

export const ClassicPrdDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceFormat: z.enum(["markdown", "yaml", "json"]),
    file: z.string().min(1),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    title: z.string().min(1).optional(),
    contextBeforeTasks: z.string(),
    preservedLegacyContent: z.string(),
    frontmatter: z.record(z.string(), JsonValueSchema),
    tasks: z.array(ClassicPrdTaskSchema).min(1),
  })
  .strict()

export type ClassicPrdDocument = z.infer<typeof ClassicPrdDocumentSchema>

export const MarkerUpdateSchema = z
  .object({
    schemaVersion: z.literal(1),
    file: z.string().min(1),
    taskId: PrdSlugSchema,
    previousStatus: TaskStatusMarkerSchema,
    status: TaskStatusMarkerSchema,
    previousContentHash: z.string().regex(/^[a-f0-9]{64}$/),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    markerByteOffset: z.number().int().nonnegative(),
    changed: z.boolean(),
    reparsed: z.literal(true),
  })
  .strict()

export type MarkerUpdate = z.infer<typeof MarkerUpdateSchema>

export type PrdParseResult = {
  ok: boolean
  document?: PrdDocument
  diagnostics: z.infer<typeof DiagnosticSchema>[]
}

export type PrdCompilationResult = {
  ok: boolean
  graph?: CompiledPrdGraph
  diagnostics: z.infer<typeof DiagnosticSchema>[]
}
