import { createHash } from "node:crypto"
import type { FileHandle } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  acquireFilesystemLease,
  assertTrustedOpenFile,
  type FilesystemLease,
  openTrustedFile,
} from "@ralph-next/telemetry"

import type {
  RawModelCallDescriptor,
  RawModelCapture,
  RawModelCaptureFactory,
} from "./openai-provider-driver"

export type FileRawModelCaptureFactoryOptions = {
  directory: string
  /** Shared diagnostic root used by streams, captures and global retention. */
  coordinationRoot?: string
  maximumBytes?: number
  /** Run-scoped public prefix; legacy callers retain raw:model. */
  referencePrefix?: string
  /** Command-owned global retention hook invoked only after durable close. */
  afterClose?: () => void | Promise<void>
  now?: () => string
}

const TERMINAL_RESERVE_BYTES = 512
const MAXIMUM_CAPTURE_ERROR_CHARACTERS = 256

function captureKey(value: RawModelCallDescriptor): string {
  return createHash("sha256")
    .update("ralph.raw-model-call.v1\0")
    .update(value.provider)
    .update("\0")
    .update(value.model)
    .update("\0")
    .update(value.callId)
    .digest("hex")
}

class FileRawModelCapture implements RawModelCapture {
  readonly ref: string
  #written = 0
  #closed = false
  #truncated = false
  #serial: Promise<void> = Promise.resolve()

  constructor(
    private readonly handle: FileHandle,
    private readonly path: string,
    private readonly activeLease: FilesystemLease,
    digest: string,
    private readonly maximumBytes: number,
    private readonly now: () => string,
    referencePrefix: string,
    private readonly afterClose?: () => void | Promise<void>,
  ) {
    this.ref = `${referencePrefix}/${digest}.jsonl`
  }

  append(event: unknown): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertOpen()
      await this.#write({ schemaVersion: 1, type: "provider.event", capturedAt: this.now(), event })
    })
  }

  close(result: { status: "succeeded" | "failed" | "cancelled"; error?: string }): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertOpen()
      let closeError: unknown
      try {
        await this.#writeTerminal({
          schemaVersion: 1,
          type: "capture.finished",
          capturedAt: this.now(),
          status: result.status,
          ...(result.error
            ? { error: result.error.slice(0, MAXIMUM_CAPTURE_ERROR_CHARACTERS) }
            : {}),
          truncated: this.#truncated,
        })
        await this.handle.sync()
        await assertTrustedOpenFile(this.path, this.handle)
        await this.activeLease.assertOwned()
      } catch (error) {
        closeError = error
      } finally {
        this.#closed = true
        try {
          await this.handle.close()
        } catch (error) {
          closeError ??= error
        }
        try {
          await this.activeLease.release()
        } catch (error) {
          closeError ??= error
        }
      }
      try {
        await this.afterClose?.()
      } catch (error) {
        closeError ??= error
      }
      if (closeError !== undefined) throw closeError
    })
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.#serial.then(operation)
    this.#serial = pending.catch(() => undefined)
    return pending
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Raw model capture is already closed")
  }

  async #write(value: unknown): Promise<void> {
    if (this.#truncated) return
    const line = `${JSON.stringify(value)}\n`
    const bytes = Buffer.byteLength(line, "utf8")
    const eventLimit = Math.max(0, this.maximumBytes - TERMINAL_RESERVE_BYTES)
    if (this.#written + bytes > eventLimit) {
      this.#truncated = true
      const marker = `${JSON.stringify({
        schemaVersion: 1,
        type: "capture.truncated",
        capturedAt: this.now(),
        maximumBytes: this.maximumBytes,
      })}\n`
      if (this.#written + Buffer.byteLength(marker, "utf8") <= eventLimit) {
        await this.activeLease.assertOwned()
        await assertTrustedOpenFile(this.path, this.handle)
        await this.handle.writeFile(marker)
        await assertTrustedOpenFile(this.path, this.handle)
        await this.activeLease.assertOwned()
        this.#written += Buffer.byteLength(marker, "utf8")
      }
      return
    }
    await this.activeLease.assertOwned()
    await assertTrustedOpenFile(this.path, this.handle)
    await this.handle.writeFile(line)
    await assertTrustedOpenFile(this.path, this.handle)
    await this.activeLease.assertOwned()
    this.#written += bytes
  }

  async #writeTerminal(value: Record<string, unknown>): Promise<void> {
    const candidates = [
      value,
      { ...value, error: undefined },
      {
        schemaVersion: 1,
        type: "capture.finished",
        status: value.status,
        truncated: true,
      },
    ]
    for (const candidate of candidates) {
      const line = `${JSON.stringify(candidate)}\n`
      const bytes = Buffer.byteLength(line, "utf8")
      if (this.#written + bytes > this.maximumBytes) continue
      await this.activeLease.assertOwned()
      await assertTrustedOpenFile(this.path, this.handle)
      await this.handle.writeFile(line)
      await assertTrustedOpenFile(this.path, this.handle)
      await this.activeLease.assertOwned()
      this.#written += bytes
      return
    }
    throw new Error("Raw model capture cannot fit its terminal settlement")
  }
}

/** Immutable JSONL capture. Call IDs must be unique; an existing target fails closed. */
export class FileRawModelCaptureFactory implements RawModelCaptureFactory {
  readonly #maximumBytes: number
  readonly #now: () => string
  readonly #referencePrefix: string
  readonly #coordinationRoot: string

  constructor(private readonly options: FileRawModelCaptureFactoryOptions) {
    this.#maximumBytes = options.maximumBytes ?? 16 * 1024 * 1024
    if (!Number.isSafeInteger(this.#maximumBytes) || this.#maximumBytes < 1_024) {
      throw new Error("Raw model capture maximumBytes must be a safe integer of at least 1024")
    }
    this.#coordinationRoot = options.coordinationRoot ?? dirname(options.directory)
    this.#referencePrefix = options.referencePrefix ?? "raw:model"
    if (!/^raw:model(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,511})?$/.test(this.#referencePrefix)) {
      throw new Error("Raw model capture reference prefix is invalid")
    }
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async open(descriptor: RawModelCallDescriptor): Promise<RawModelCapture> {
    const digest = captureKey(descriptor)
    const directory = join(this.options.directory, digest.slice(0, 2))
    const target = join(directory, `${digest}.jsonl`)
    // Capture leases always precede the shared mutation lease. The same order
    // is used when an open capture later invokes retention from afterClose.
    const activeLease = await acquireFilesystemLease(directory, `${digest}.jsonl.capture.lock`)
    let mutationLease: FilesystemLease | undefined
    let handle: FileHandle | undefined
    let mutationReleased = false
    try {
      await activeLease.assertOwned()
      mutationLease = await acquireFilesystemLease(this.#coordinationRoot, ".raw.mutation.lock")
      await activeLease.assertOwned()
      await mutationLease.assertOwned()
      handle = await openTrustedFile(target, "exclusive", 0o600)
      await assertTrustedOpenFile(target, handle)
      await mutationLease.assertOwned()
      await mutationLease.release()
      mutationReleased = true
      return new FileRawModelCapture(
        handle,
        target,
        activeLease,
        digest,
        this.#maximumBytes,
        this.#now,
        this.#referencePrefix,
        this.options.afterClose,
      )
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await activeLease.release().catch(() => undefined)
      throw error
    } finally {
      if (mutationLease && !mutationReleased) await mutationLease.release()
    }
  }
}
