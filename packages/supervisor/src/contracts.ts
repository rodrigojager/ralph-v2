import { z } from "zod"

const PositiveBytesSchema = z.number().int().positive()
const EnvironmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
// The inherited host environment is only a lookup source and is never copied
// wholesale to a child. Windows exposes legitimate names such as
// `ProgramFiles(x86)`, so target-name restrictions do not apply here.
const HostEnvironmentNameSchema = z
  .string()
  .min(1)
  .max(32_767)
  .refine((value) => !value.includes("\0"), "Host environment name contains NUL")
const EnvironmentReferenceSchema = z.string().regex(/^(?:env|environment):[A-Za-z_][A-Za-z0-9_]*$/)

export const ShellExecutionSchema = z
  .object({
    kind: z.enum(["powershell", "cmd", "sh", "bash", "custom"]),
    script: z.string().min(1).max(1_048_576),
    executable: z.string().min(1).max(4_096).optional(),
  })
  .strict()
  .refine((value) => value.kind !== "custom" || value.executable !== undefined, {
    message: "A custom shell requires an executable",
  })
export type ShellExecution = z.infer<typeof ShellExecutionSchema>

export const SupervisedProcessSpecSchema = z
  .object({
    executable: z.string().min(1).max(4_096),
    args: z.array(z.string().max(65_536)).max(1_024),
    cwd: z.string().min(1).max(32_768),
    environment: z.record(HostEnvironmentNameSchema, z.string().optional()),
    environmentRefs: z.record(EnvironmentNameSchema, EnvironmentReferenceSchema).optional(),
    environmentAllowlist: z.array(EnvironmentNameSchema).max(256).optional(),
    shell: z.union([z.literal(false), ShellExecutionSchema]).default(false),
    timeoutMs: z.number().int().positive(),
    gracePeriodMs: z.number().int().nonnegative().default(750),
    outputLimitBytes: PositiveBytesSchema,
    rawOutputLimitBytes: PositiveBytesSchema,
    maxInputBytes: PositiveBytesSchema.default(4 * 1_024 * 1_024),
    stdin: z.union([z.string(), z.instanceof(Uint8Array)]).optional(),
    secretValues: z.array(z.string()).optional(),
  })
  .strict()
  .refine((value) => value.rawOutputLimitBytes >= value.outputLimitBytes, {
    message: "rawOutputLimitBytes must be greater than or equal to outputLimitBytes",
    path: ["rawOutputLimitBytes"],
  })
  .superRefine((value, context) => {
    if (value.stdin === undefined) return
    const bytes =
      typeof value.stdin === "string"
        ? Buffer.byteLength(value.stdin, "utf8")
        : value.stdin.byteLength
    if (bytes > value.maxInputBytes) {
      context.addIssue({
        code: "custom",
        message: `stdin exceeds maxInputBytes (${value.maxInputBytes})`,
        path: ["stdin"],
      })
    }
  })
export type SupervisedProcessSpec = z.infer<typeof SupervisedProcessSpecSchema>
export type SupervisedProcessSpecInput = z.input<typeof SupervisedProcessSpecSchema>

export type ProcessOutputChunk = {
  sequence: number
  stream: "stdout" | "stderr"
  text: string
  bytes: number
  totalBytes: number
  at: string
}

export type SupervisedProcessRequest = Omit<
  SupervisedProcessSpecInput,
  "args" | "environment" | "environmentRefs" | "environmentAllowlist" | "secretValues"
> & {
  args: readonly string[]
  environment: Readonly<Record<string, string | undefined>>
  environmentRefs?: Readonly<Record<string, string>>
  environmentAllowlist?: readonly string[]
  secretValues?: readonly string[]
  /** Runtime-only boundary; excluded from the serializable process schema. */
  expectedCanonicalCwd?: string
  /** Runtime-only executable binding; excluded from the public serializable process schema. */
  expectedExecutableSha256?: string
  signal?: AbortSignal
  onOutput?: (stream: "stdout" | "stderr", delta: string) => void | Promise<void>
  onChunk?: (chunk: ProcessOutputChunk) => void | Promise<void>
}

export const ProcessSettlementSchema = z
  .object({
    pid: z.number().int().positive().optional(),
    argv: z.array(z.string()),
    cwd: z.string(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    stdout: z.string(),
    stderr: z.string(),
    rawStdout: z.string(),
    rawStderr: z.string(),
    stdoutBytes: z.number().int().nonnegative(),
    stderrBytes: z.number().int().nonnegative(),
    outputTruncated: z.boolean(),
    rawOutputTruncated: z.boolean(),
    timedOut: z.boolean(),
    cancelled: z.boolean(),
    treeTerminated: z.boolean(),
    outputRefs: z.array(z.string()),
    durationMs: z.number().nonnegative(),
    error: z.string().optional(),
  })
  .strict()
export type ProcessSettlement = z.infer<typeof ProcessSettlementSchema>

export type SupervisedProcessHandle = {
  readonly pid?: number
  readonly settlement: Promise<ProcessSettlement>
  cancel(reason?: string): Promise<void>
  forceKill(reason?: string): Promise<void>
}

export interface ProcessOutputStore {
  persist(input: {
    processId: string
    stream: "stdout" | "stderr"
    content: string
    truncated: boolean
  }): Promise<string>
}

export interface ProcessSupervisor {
  start(request: SupervisedProcessRequest): Promise<SupervisedProcessHandle>
  run(request: SupervisedProcessRequest): Promise<ProcessSettlement>
  which(
    executable: string,
    environment?: Readonly<Record<string, string | undefined>>,
  ): string | null
}
