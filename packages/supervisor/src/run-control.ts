import { randomUUID } from "node:crypto"
import { lstat, open, realpath } from "node:fs/promises"
import {
  type AddressInfo,
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net"
import { hostname as localHostname } from "node:os"
import { dirname, resolve } from "node:path"
import { z } from "zod"
import { type ProcessIdentity, probePidLiveness, processStartToken } from "./process-identity"
import {
  createWorkerCapabilityToken,
  hashWorkerCapabilityToken,
  MAX_TIMER_DELAY_MS,
  matchesWorkerCapabilityToken,
} from "./worker-protocol"

const NonEmptyStringSchema = z.string().trim().min(1).max(4_096)
const TimestampSchema = z.iso.datetime({ offset: true })
const CapabilityTokenSchema = z.string().min(32).max(512)
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const MAX_CONTROL_MESSAGE_BYTES = 256 * 1_024
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000

export const RUN_CONTROL_PROTOCOL_VERSION = 1 as const

export const RunControlProcessIdentitySchema = z
  .object({
    pid: z.number().int().positive(),
    processStartToken: NonEmptyStringSchema,
    hostname: NonEmptyStringSchema,
  })
  .strict()

export const RunControlDescriptorSchema = z
  .object({
    schemaVersion: z.literal(RUN_CONTROL_PROTOCOL_VERSION),
    instanceId: NonEmptyStringSchema,
    workspaceId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    process: RunControlProcessIdentitySchema,
    transport: z
      .object({
        kind: z.literal("tcp-loopback"),
        host: z.literal("127.0.0.1"),
        port: z.number().int().min(1).max(65_535),
      })
      .strict(),
    capabilityToken: CapabilityTokenSchema,
    capabilityHash: Sha256Schema,
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (hashWorkerCapabilityToken(value.capabilityToken) !== value.capabilityHash) {
      context.addIssue({
        code: "custom",
        path: ["capabilityHash"],
        message: "Run-control capability token and hash do not match",
      })
    }
  })
export type RunControlDescriptor = z.infer<typeof RunControlDescriptorSchema>

export const RunControlActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("stop"),
      mode: z.enum(["graceful", "force"]),
      reason: NonEmptyStringSchema,
      graceMs: z.number().int().nonnegative().max(MAX_TIMER_DELAY_MS).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("context-rotate"),
      reason: NonEmptyStringSchema,
    })
    .strict(),
])
export type RunControlAction = z.infer<typeof RunControlActionSchema>

export const RunControlRequestSchema = z
  .object({
    schemaVersion: z.literal(RUN_CONTROL_PROTOCOL_VERSION),
    requestId: NonEmptyStringSchema,
    workspaceId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    expectedInstanceId: NonEmptyStringSchema,
    expectedProcess: RunControlProcessIdentitySchema,
    capabilityToken: CapabilityTokenSchema,
    requestedAt: TimestampSchema,
    action: RunControlActionSchema,
  })
  .strict()
export type RunControlRequest = z.infer<typeof RunControlRequestSchema>

export const RunControlResponseSchema = z
  .object({
    schemaVersion: z.literal(RUN_CONTROL_PROTOCOL_VERSION),
    requestId: NonEmptyStringSchema,
    workspaceId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    instanceId: NonEmptyStringSchema,
    handledAt: TimestampSchema,
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: NonEmptyStringSchema,
        message: NonEmptyStringSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ok === (value.error !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "A run-control response must carry either a result or an error disposition",
      })
    }
  })
export type RunControlResponse = z.infer<typeof RunControlResponseSchema>

export type RunControlRequestHandler = (request: RunControlRequest) => unknown | Promise<unknown>

export type RunControlServer = {
  readonly descriptor: RunControlDescriptor
  close(): Promise<void>
}

export type StartRunControlServerOptions = {
  readonly workspaceId: string
  readonly runId: string
  readonly instanceId: string
  readonly process: ProcessIdentity
  readonly handle: RunControlRequestHandler
  readonly publish: (descriptor: RunControlDescriptor) => void | Promise<void>
  readonly unpublish: (descriptor: RunControlDescriptor) => void | Promise<void>
}

export class RunControlClientError extends Error {
  readonly code: string
  readonly ownerState: "missing" | "dead" | "identity-mismatch" | "unreachable" | "invalid"

  constructor(
    code: string,
    message: string,
    ownerState: RunControlClientError["ownerState"],
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = "RunControlClientError"
    this.code = code
    this.ownerState = ownerState
  }
}

function sameHost(left: string, right: string): boolean {
  return left.toLocaleLowerCase("und") === right.toLocaleLowerCase("und")
}

function sameProcess(
  left: z.infer<typeof RunControlProcessIdentitySchema>,
  right: z.infer<typeof RunControlProcessIdentitySchema>,
): boolean {
  return (
    left.pid === right.pid &&
    left.processStartToken === right.processStartToken &&
    sameHost(left.hostname, right.hostname)
  )
}

function boundedErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096) || "Unknown error"
}

function closeSocket(socket: Socket): void {
  if (!socket.destroyed) socket.destroy()
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()))
  })
}

function writeResponse(socket: Socket, response: RunControlResponse): void {
  const bytes = Buffer.from(`${JSON.stringify(RunControlResponseSchema.parse(response))}\n`, "utf8")
  if (bytes.byteLength > MAX_CONTROL_MESSAGE_BYTES) {
    throw new Error("Run-control response exceeds its bounded transport limit")
  }
  socket.end(bytes)
}

/**
 * Starts a command-owned loopback endpoint. Requests are serialized so two
 * clients can never race official stop/context transitions through one owner.
 * The bearer capability is stored only in the mode-0600 descriptor supplied
 * by the composition root; it is never logged or returned over the protocol.
 * This binds ordinary clients and stale descriptors, but is not an OS sandbox
 * against hostile code already running as the same user.
 */
export async function startRunControlServer(
  options: StartRunControlServerOptions,
): Promise<RunControlServer> {
  const expectedProcess = RunControlProcessIdentitySchema.parse(options.process)
  if (expectedProcess.pid !== process.pid || !sameHost(expectedProcess.hostname, localHostname())) {
    throw new Error("Run-control server identity does not describe the current process")
  }
  const observedStart = await processStartToken(process.pid)
  if (observedStart !== expectedProcess.processStartToken) {
    throw new Error("Run-control server process-start token does not match the current process")
  }
  const workspaceId = NonEmptyStringSchema.parse(options.workspaceId)
  const runId = NonEmptyStringSchema.parse(options.runId)
  const instanceId = NonEmptyStringSchema.parse(options.instanceId)
  const capabilityToken = createWorkerCapabilityToken()
  const capabilityHash = hashWorkerCapabilityToken(capabilityToken)
  let handling = Promise.resolve()
  const sockets = new Set<Socket>()

  const server = createServer((socket) => {
    sockets.add(socket)
    socket.setNoDelay(true)
    let buffered = Buffer.alloc(0)
    let settled = false
    const fail = (requestId: string, code: string, message: string): void => {
      if (settled) return
      settled = true
      try {
        writeResponse(socket, {
          schemaVersion: RUN_CONTROL_PROTOCOL_VERSION,
          requestId,
          workspaceId,
          runId,
          instanceId,
          handledAt: new Date().toISOString(),
          ok: false,
          error: { code, message: message.slice(0, 4_096) || code },
        })
      } catch {
        closeSocket(socket)
      }
    }
    socket.on("data", (chunk: Buffer) => {
      if (settled) return
      buffered = Buffer.concat([buffered, chunk])
      if (buffered.byteLength > MAX_CONTROL_MESSAGE_BYTES) {
        fail("unparsed", "RALPH_RUN_CONTROL_MESSAGE_TOO_LARGE", "Run-control request is too large")
        return
      }
      const newline = buffered.indexOf(0x0a)
      if (newline < 0) return
      if (buffered.subarray(newline + 1).some((byte) => byte !== 0x0d && byte !== 0x0a)) {
        fail(
          "unparsed",
          "RALPH_RUN_CONTROL_TRAILING_DATA",
          "Run-control accepts one request per connection",
        )
        return
      }
      let request: RunControlRequest
      try {
        request = RunControlRequestSchema.parse(
          JSON.parse(buffered.subarray(0, newline).toString("utf8")),
        )
      } catch (error) {
        fail("unparsed", "RALPH_RUN_CONTROL_REQUEST_INVALID", boundedErrorMessage(error))
        return
      }
      if (
        request.workspaceId !== workspaceId ||
        request.runId !== runId ||
        request.expectedInstanceId !== instanceId ||
        !sameProcess(request.expectedProcess, expectedProcess) ||
        !matchesWorkerCapabilityToken(request.capabilityToken, capabilityHash)
      ) {
        fail(
          request.requestId,
          "RALPH_RUN_CONTROL_AUTHORITY_MISMATCH",
          "Run-control request authority does not match the live supervisor",
        )
        return
      }
      settled = true
      handling = handling
        .then(async () => {
          try {
            const result = await options.handle(request)
            writeResponse(socket, {
              schemaVersion: RUN_CONTROL_PROTOCOL_VERSION,
              requestId: request.requestId,
              workspaceId,
              runId,
              instanceId,
              handledAt: new Date().toISOString(),
              ok: true,
              ...(result === undefined ? {} : { result }),
            })
          } catch (error) {
            writeResponse(socket, {
              schemaVersion: RUN_CONTROL_PROTOCOL_VERSION,
              requestId: request.requestId,
              workspaceId,
              runId,
              instanceId,
              handledAt: new Date().toISOString(),
              ok: false,
              error: {
                code: "RALPH_RUN_CONTROL_HANDLER_FAILED",
                message: boundedErrorMessage(error),
              },
            })
          }
        })
        .catch(() => closeSocket(socket))
    })
    socket.on("error", () => closeSocket(socket))
    socket.on("close", () => sockets.delete(socket))
  })
  server.on("error", () => {
    for (const socket of sockets) closeSocket(socket)
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => rejectListen(error)
    server.once("error", onError)
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.off("error", onError)
      resolveListen()
    })
  })
  const address = server.address() as AddressInfo | null
  if (!address || address.address !== "127.0.0.1" || address.port < 1) {
    await closeServer(server)
    throw new Error("Run-control server did not bind the requested loopback transport")
  }
  const descriptor = RunControlDescriptorSchema.parse({
    schemaVersion: RUN_CONTROL_PROTOCOL_VERSION,
    instanceId,
    workspaceId,
    runId,
    process: expectedProcess,
    transport: { kind: "tcp-loopback", host: "127.0.0.1", port: address.port },
    capabilityToken,
    capabilityHash,
    createdAt: new Date().toISOString(),
  })
  try {
    await options.publish(descriptor)
  } catch (error) {
    await closeServer(server).catch(() => undefined)
    throw error
  }
  let closed = false
  return {
    descriptor,
    async close() {
      if (closed) return
      closed = true
      let unpublishFailure: unknown
      try {
        await options.unpublish(descriptor)
      } catch (error) {
        unpublishFailure = error
      } finally {
        for (const socket of sockets) closeSocket(socket)
        await closeServer(server).catch((error) => {
          unpublishFailure ??= error
        })
        await handling.catch(() => undefined)
      }
      if (unpublishFailure) throw unpublishFailure
    },
  }
}

async function stableDescriptor(path: string): Promise<RunControlDescriptor> {
  const absolute = resolve(path)
  const parent = dirname(absolute)
  const canonicalParent = await realpath(parent).catch((cause) => {
    throw new RunControlClientError(
      "RALPH_RUN_CONTROL_DESCRIPTOR_MISSING",
      "Run-control descriptor directory is unavailable",
      "missing",
      { cause },
    )
  })
  const comparable = (value: string): string =>
    process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value
  if (comparable(canonicalParent) !== comparable(resolve(parent))) {
    throw new RunControlClientError(
      "RALPH_RUN_CONTROL_DESCRIPTOR_UNSAFE",
      "Run-control descriptor directory traverses a symbolic link or junction",
      "invalid",
    )
  }
  const parentInfo = await lstat(parent).catch((cause) => {
    throw new RunControlClientError(
      "RALPH_RUN_CONTROL_DESCRIPTOR_MISSING",
      "Run-control descriptor directory is unavailable",
      "missing",
      { cause },
    )
  })
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new RunControlClientError(
      "RALPH_RUN_CONTROL_DESCRIPTOR_UNSAFE",
      "Run-control descriptor directory is not a safe local directory",
      "invalid",
    )
  }
  let before: Awaited<ReturnType<typeof lstat>>
  try {
    before = await lstat(absolute)
  } catch (cause) {
    throw new RunControlClientError(
      "RALPH_RUN_CONTROL_DESCRIPTOR_MISSING",
      "No live supervisor control descriptor is present",
      "missing",
      { cause },
    )
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > MAX_CONTROL_MESSAGE_BYTES ||
    (process.platform !== "win32" && (before.mode & 0o077) !== 0)
  ) {
    throw new RunControlClientError(
      "RALPH_RUN_CONTROL_DESCRIPTOR_UNSAFE",
      "Run-control descriptor is linked, non-regular, oversized, or has unsafe permissions",
      "invalid",
    )
  }
  const handle = await open(absolute, "r")
  try {
    const beforeHandle = await handle.stat()
    const bytes = await handle.readFile()
    const afterHandle = await handle.stat()
    if (
      before.dev !== beforeHandle.dev ||
      before.ino !== beforeHandle.ino ||
      beforeHandle.dev !== afterHandle.dev ||
      beforeHandle.ino !== afterHandle.ino ||
      beforeHandle.size !== afterHandle.size ||
      beforeHandle.mtimeMs !== afterHandle.mtimeMs
    ) {
      throw new RunControlClientError(
        "RALPH_RUN_CONTROL_DESCRIPTOR_CHANGED",
        "Run-control descriptor changed while it was read",
        "invalid",
      )
    }
    return RunControlDescriptorSchema.parse(JSON.parse(bytes.toString("utf8")))
  } catch (cause) {
    if (cause instanceof RunControlClientError) throw cause
    throw new RunControlClientError(
      "RALPH_RUN_CONTROL_DESCRIPTOR_INVALID",
      "Run-control descriptor is malformed",
      "invalid",
      { cause },
    )
  } finally {
    await handle.close()
  }
}

async function assertLiveDescriptorOwner(descriptor: RunControlDescriptor): Promise<void> {
  if (!sameHost(descriptor.process.hostname, localHostname())) {
    throw new RunControlClientError(
      "RALPH_RUN_CONTROL_OWNER_REMOTE",
      "The recorded supervisor belongs to another host and cannot be controlled locally",
      "unreachable",
    )
  }
  const liveness = probePidLiveness(descriptor.process.pid)
  if (!liveness.alive && !liveness.inaccessible) {
    throw new RunControlClientError(
      "RALPH_RUN_CONTROL_OWNER_DEAD",
      "The recorded supervisor process is no longer alive",
      "dead",
    )
  }
  if (liveness.inaccessible) {
    throw new RunControlClientError(
      "RALPH_RUN_CONTROL_OWNER_UNVERIFIABLE",
      "The supervisor PID exists but its process identity cannot be verified",
      "unreachable",
    )
  }
  let observed: string
  try {
    observed = await processStartToken(descriptor.process.pid)
  } catch (cause) {
    throw new RunControlClientError(
      "RALPH_RUN_CONTROL_OWNER_UNVERIFIABLE",
      "The supervisor process-start token cannot be verified",
      "unreachable",
      { cause },
    )
  }
  if (observed !== descriptor.process.processStartToken) {
    throw new RunControlClientError(
      "RALPH_RUN_CONTROL_OWNER_REUSED_PID",
      "The recorded supervisor PID belongs to a different process start",
      "identity-mismatch",
    )
  }
}

export type SendRunControlRequestOptions = {
  readonly descriptorPath: string
  readonly workspaceId: string
  readonly runId: string
  readonly action: RunControlAction
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

/** Sends an authenticated request only after PID + process-start-token proof. */
export async function sendRunControlRequest(
  options: SendRunControlRequestOptions,
): Promise<{ descriptor: RunControlDescriptor; response: RunControlResponse }> {
  if (options.signal?.aborted) {
    throw new RunControlClientError(
      "RALPH_RUN_CONTROL_ABORTED",
      "Run-control request was cancelled before delivery",
      "unreachable",
    )
  }
  const descriptor = await stableDescriptor(options.descriptorPath)
  if (descriptor.workspaceId !== options.workspaceId || descriptor.runId !== options.runId) {
    throw new RunControlClientError(
      "RALPH_RUN_CONTROL_SCOPE_MISMATCH",
      "Run-control descriptor belongs to another workspace or run",
      "invalid",
    )
  }
  await assertLiveDescriptorOwner(descriptor)
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new RunControlClientError(
      "RALPH_RUN_CONTROL_TIMEOUT_INVALID",
      "Run-control timeout must be a positive timer-safe integer",
      "invalid",
    )
  }
  const request = RunControlRequestSchema.parse({
    schemaVersion: RUN_CONTROL_PROTOCOL_VERSION,
    requestId: randomUUID(),
    workspaceId: descriptor.workspaceId,
    runId: descriptor.runId,
    expectedInstanceId: descriptor.instanceId,
    expectedProcess: descriptor.process,
    capabilityToken: descriptor.capabilityToken,
    requestedAt: new Date().toISOString(),
    action: options.action,
  })
  const response = await new Promise<RunControlResponse>((resolveResponse, rejectResponse) => {
    const socket = createConnection({
      host: descriptor.transport.host,
      port: descriptor.transport.port,
    })
    let buffer = Buffer.alloc(0)
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      options.signal?.removeEventListener("abort", abort)
    }
    const timeout = setTimeout(() => {
      fail(
        new RunControlClientError(
          "RALPH_RUN_CONTROL_TIMEOUT",
          "The verified supervisor did not settle the control request before timeout",
          "unreachable",
        ),
      )
    }, timeoutMs)
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      closeSocket(socket)
      rejectResponse(
        error instanceof RunControlClientError
          ? error
          : new RunControlClientError(
              "RALPH_RUN_CONTROL_UNREACHABLE",
              `The verified supervisor control channel is unavailable: ${boundedErrorMessage(error)}`,
              "unreachable",
              { cause: error },
            ),
      )
    }
    const abort = (): void => {
      fail(
        new RunControlClientError(
          "RALPH_RUN_CONTROL_ABORTED",
          "Run-control request was cancelled while awaiting the verified supervisor",
          "unreachable",
        ),
      )
    }
    options.signal?.addEventListener("abort", abort, { once: true })
    if (options.signal?.aborted) {
      abort()
      return
    }
    socket.once("connect", () => {
      const bytes = Buffer.from(`${JSON.stringify(request)}\n`, "utf8")
      if (bytes.byteLength > MAX_CONTROL_MESSAGE_BYTES) {
        fail(new Error("Run-control request exceeds its bounded transport limit"))
        return
      }
      socket.write(bytes)
    })
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.byteLength > MAX_CONTROL_MESSAGE_BYTES) {
        fail(new Error("Run-control response exceeds its bounded transport limit"))
        return
      }
      const newline = buffer.indexOf(0x0a)
      if (newline < 0) return
      try {
        const parsed = RunControlResponseSchema.parse(
          JSON.parse(buffer.subarray(0, newline).toString("utf8")),
        )
        if (
          parsed.requestId !== request.requestId ||
          parsed.workspaceId !== descriptor.workspaceId ||
          parsed.runId !== descriptor.runId ||
          parsed.instanceId !== descriptor.instanceId
        ) {
          throw new Error("Run-control response is not bound to the request and live owner")
        }
        if (settled) return
        settled = true
        cleanup()
        closeSocket(socket)
        resolveResponse(parsed)
      } catch (error) {
        fail(error)
      }
    })
    socket.once("error", fail)
    socket.once("end", () => {
      if (buffer.indexOf(0x0a) < 0) fail(new Error("Run-control channel closed without a response"))
    })
  })
  if (!response.ok) {
    throw new RunControlClientError(
      response.error?.code ?? "RALPH_RUN_CONTROL_REJECTED",
      response.error?.message ?? "The live supervisor rejected the control request",
      "unreachable",
    )
  }
  return { descriptor, response }
}

/** Reads a descriptor for diagnostics without using its capability. */
export async function inspectRunControlDescriptor(path: string): Promise<RunControlDescriptor> {
  return stableDescriptor(path)
}
