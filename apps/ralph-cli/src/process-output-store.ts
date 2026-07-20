import { randomUUID } from "node:crypto"
import { realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { StringDecoder } from "node:string_decoder"
import {
  appendRawStream,
  applyDiagnosticRawRetention,
  DEFAULT_RAW_STREAM_RETENTION,
  type DiagnosticRawRetentionPolicy,
  ensureRunLayout,
  runLayout,
  workspaceLayout,
} from "@ralph-next/persistence"
import { BunProcessSupervisor, type ProcessOutputStore } from "@ralph-next/supervisor"
import { redactText } from "@ralph-next/telemetry"

const PROCESS_RAW_RECORD_DATA_BYTES = 16_384

function utf8Chunks(value: Buffer): string[] {
  const decoder = new StringDecoder("utf8")
  const output: string[] = []
  for (let offset = 0; offset < value.byteLength; offset += PROCESS_RAW_RECORD_DATA_BYTES) {
    const decoded = decoder.write(
      value.subarray(offset, Math.min(value.byteLength, offset + PROCESS_RAW_RECORD_DATA_BYTES)),
    )
    if (decoded.length > 0) output.push(decoded)
  }
  const tail = decoder.end()
  if (tail.length > 0) output.push(tail)
  return output.length > 0 ? output : [""]
}

export type WorkspaceProcessOutputStoreOptions = {
  workspaceRoot: string
  /** When omitted, output is still preserved under .ralph/cache/process-output. */
  runId?: string
  maximumBytes?: number
  secretValues?: readonly string[]
  /** Optional raw output is absent, not represented by a placeholder ref. */
  persistRawOutput?: boolean
  retention?: DiagnosticRawRetentionPolicy
}

/** Persists supervisor-retained output in redacted, rotated structured streams. */
export class WorkspaceProcessOutputStore implements ProcessOutputStore {
  readonly #workspaceRoot: string
  readonly #runId: string | undefined
  readonly #maximumBytes: number
  readonly #secretValues: readonly string[]
  readonly #retention: DiagnosticRawRetentionPolicy | undefined
  readonly #streamNamespace = randomUUID()

  constructor(options: WorkspaceProcessOutputStoreOptions) {
    if (options.persistRawOutput === false) {
      throw new Error(
        "WorkspaceProcessOutputStore cannot be constructed when raw output is disabled",
      )
    }
    this.#workspaceRoot = resolve(options.workspaceRoot)
    if (options.runId !== undefined) {
      runLayout(workspaceLayout(this.#workspaceRoot), options.runId)
      this.#runId = options.runId
    }
    this.#retention = options.retention
    this.#maximumBytes = Math.min(
      options.maximumBytes ?? DEFAULT_RAW_STREAM_RETENTION.maxSegmentBytes,
      options.retention?.maximumFileBytes ?? DEFAULT_RAW_STREAM_RETENTION.maxSegmentBytes,
    )
    if (!Number.isSafeInteger(this.#maximumBytes) || this.#maximumBytes < 1) {
      throw new Error("WorkspaceProcessOutputStore maximumBytes must be a positive safe integer")
    }
    this.#secretValues = [...(options.secretValues ?? [])]
  }

  async persist(input: {
    processId: string
    stream: "stdout" | "stderr"
    content: string
    truncated: boolean
  }): Promise<string> {
    const root = await realpath(this.#workspaceRoot)
    const layout = workspaceLayout(root)
    const retentionRoot = this.#runId
      ? join((await ensureRunLayout(layout, this.#runId)).raw, "diagnostic")
      : join(layout.cache, "process-output")
    const redacted = redactText(input.content, this.#secretValues)
    const allBytes = Buffer.from(redacted, "utf8")
    const retained = allBytes.subarray(0, Math.min(allBytes.byteLength, this.#maximumBytes))
    const sourceTruncated = input.truncated || retained.byteLength < allBytes.byteLength
    const chunks = utf8Chunks(retained)
    let rawRef: string | undefined
    for (const [index, data] of chunks.entries()) {
      const appended = await appendRawStream({
        rawRoot: retentionRoot,
        streamKind: "process",
        streamId: `${this.#streamNamespace}:${input.processId}:${input.stream}`,
        ...(this.#runId ? { referenceScope: this.#runId } : {}),
        channel: input.stream,
        data,
        processId: input.processId,
        ...(sourceTruncated && index === chunks.length - 1 ? { sourceTruncated: true } : {}),
        secrets: this.#secretValues,
        ...(this.#retention
          ? {
              retention: {
                maxSegmentBytes: this.#retention.maximumFileBytes,
                maxSegments: this.#retention.maximumFiles,
                maxTotalBytes: this.#retention.maximumTotalBytes,
                ...(this.#retention.maximumAgeMs === undefined
                  ? {}
                  : { maxAgeMs: this.#retention.maximumAgeMs }),
              },
            }
          : {}),
      })
      if (this.#runId) {
        rawRef = appended.rawRef
      } else {
        const cacheReference = /^run-raw:\/\/(process\/[a-f0-9]{64}\/stream)$/u.exec(
          appended.rawRef,
        )?.[1]
        if (!cacheReference) {
          throw new Error("Workspace process raw stream returned an invalid cache reference")
        }
        rawRef = `workspace-raw://${cacheReference}`
      }
    }
    if (this.#retention) {
      const receipt = await applyDiagnosticRawRetention(retentionRoot, this.#retention)
      if (receipt.blocked || receipt.overBudget) {
        throw new Error(
          `Process raw retention was not enforced: ${receipt.blockedReason ?? "root remains over budget"}`,
        )
      }
    }
    if (!rawRef) throw new Error("Process raw output did not produce a durable reference")
    return rawRef
  }
}

export function createWorkspaceBunProcessSupervisor(
  options: WorkspaceProcessOutputStoreOptions,
): BunProcessSupervisor {
  return options.persistRawOutput === false
    ? new BunProcessSupervisor()
    : new BunProcessSupervisor({ outputStore: new WorkspaceProcessOutputStore(options) })
}
