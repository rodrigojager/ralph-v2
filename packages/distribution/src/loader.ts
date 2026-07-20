import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, open, readFile, realpath, unlink } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { EXIT_CODES, RalphError } from "@ralph-next/domain"
import {
  type InstallOrigin,
  type ReleaseManifest,
  ReleaseManifestSchema,
  type ReleasePayload,
} from "./contracts"

const DEFAULT_MANIFEST_LIMIT_BYTES = 1024 * 1024
const DEFAULT_PAYLOAD_LIMIT_BYTES = 512 * 1024 * 1024

function loaderError(
  code: string,
  message: string,
  options: {
    file?: string
    hint?: string
    cause?: unknown
    details?: Record<string, unknown>
  } = {},
) {
  return new RalphError(code, message, {
    exitCode: EXIT_CODES.operationalError,
    ...options,
  })
}

function validateByteLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > DEFAULT_PAYLOAD_LIMIT_BYTES) {
    throw loaderError(
      "RALPH_RELEASE_BYTE_LIMIT_INVALID",
      `Release byte limit must be between 1 and ${DEFAULT_PAYLOAD_LIMIT_BYTES}: ${String(limit)}`,
    )
  }
  return limit
}

function parseJsonManifest(bytes: Uint8Array, source: string): ReleaseManifest {
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch (error) {
    throw loaderError(
      "RALPH_RELEASE_MANIFEST_JSON_INVALID",
      `Invalid release manifest: ${source}`,
      {
        file: source,
        cause: error,
      },
    )
  }
  const parsed = ReleaseManifestSchema.safeParse(json)
  if (!parsed.success) {
    throw loaderError(
      "RALPH_RELEASE_MANIFEST_SCHEMA_INVALID",
      `Release manifest does not satisfy schema v2 with an explicit support matrix: ${source}`,
      { file: source, details: { issues: parsed.error.issues } },
    )
  }
  return parsed.data
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

export function verifyReleasePayloadBytes(
  payload: ReleasePayload,
  bytes: Uint8Array,
  source: string,
): void {
  if (bytes.byteLength !== payload.sizeBytes) {
    throw loaderError(
      "RALPH_RELEASE_PAYLOAD_SIZE_MISMATCH",
      `Release payload size does not match manifest: ${source}`,
      { file: source, details: { expected: payload.sizeBytes, actual: bytes.byteLength } },
    )
  }
  const actualSha256 = sha256Bytes(bytes)
  if (actualSha256 !== payload.sha256.toLowerCase()) {
    throw loaderError(
      "RALPH_RELEASE_PAYLOAD_HASH_MISMATCH",
      `Release payload SHA-256 does not match manifest: ${source}`,
      { file: source, details: { expected: payload.sha256, actual: actualSha256 } },
    )
  }
}

async function readRegularFile(path: string, maximumBytes: number): Promise<Uint8Array> {
  const resolved = resolve(path)
  const information = await lstat(resolved).catch((error: unknown) => {
    throw loaderError(
      "RALPH_RELEASE_FILE_UNAVAILABLE",
      `Release file is unavailable: ${resolved}`,
      {
        file: resolved,
        cause: error,
      },
    )
  })
  if (information.isSymbolicLink() || !information.isFile()) {
    throw loaderError(
      "RALPH_RELEASE_FILE_NOT_REGULAR",
      `Release source must be a regular file: ${resolved}`,
      { file: resolved },
    )
  }
  if (information.size > maximumBytes) {
    throw loaderError(
      "RALPH_RELEASE_FILE_TOO_LARGE",
      `Release file exceeds the allowed size: ${resolved}`,
      { file: resolved, details: { maximumBytes, actualBytes: information.size } },
    )
  }
  return new Uint8Array(await readFile(resolved))
}

export interface ReleaseFetchRequest {
  readonly url: URL
  readonly signal?: AbortSignal
  readonly maximumBytes: number
  readonly acceptedMediaTypes?: readonly string[]
}

export interface ReleaseTransport {
  fetch(request: ReleaseFetchRequest): Promise<Uint8Array>
  streamToFile?(request: ReleaseFetchRequest, destination: string): Promise<StagedReleasePayload>
}

export interface StagedReleasePayload {
  readonly path: string
  readonly sizeBytes: number
  readonly sha256: string
}

async function writeExclusiveChunks(
  destination: string,
  chunks: AsyncIterable<Uint8Array>,
  maximumBytes: number,
): Promise<StagedReleasePayload> {
  const resolved = resolve(destination)
  const handle = await open(resolved, "wx", 0o600).catch((error: unknown) => {
    throw loaderError(
      "RALPH_RELEASE_STAGING_COLLISION",
      `Release staging destination already exists or cannot be created: ${resolved}`,
      { file: resolved, cause: error },
    )
  })
  const hash = createHash("sha256")
  let sizeBytes = 0
  try {
    for await (const chunk of chunks) {
      sizeBytes += chunk.byteLength
      if (sizeBytes > maximumBytes) {
        throw loaderError(
          "RALPH_RELEASE_DOWNLOAD_TOO_LARGE",
          "Release response exceeded the configured byte limit while streaming",
          { file: resolved, details: { maximumBytes, observedBytes: sizeBytes } },
        )
      }
      hash.update(chunk)
      let offset = 0
      while (offset < chunk.byteLength) {
        const written = await handle.write(chunk, offset, chunk.byteLength - offset)
        if (written.bytesWritten <= 0) {
          throw loaderError(
            "RALPH_RELEASE_STAGING_WRITE_INCOMPLETE",
            `Release staging write made no progress: ${resolved}`,
            { file: resolved },
          )
        }
        offset += written.bytesWritten
      }
    }
    await handle.sync()
    return { path: resolved, sizeBytes, sha256: hash.digest("hex") }
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(resolved).catch(() => undefined)
    throw error
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function inspectStagedDestination(
  requestedDestination: string,
  containmentRoot: string,
  maximumBytes: number,
): Promise<StagedReleasePayload> {
  const destination = resolve(requestedDestination)
  const root = await realpath(resolve(containmentRoot))
  const information = await lstat(destination).catch((error: unknown) => {
    throw loaderError(
      "RALPH_RELEASE_STAGING_DESTINATION_UNAVAILABLE",
      `Transport did not materialize the requested staging destination: ${destination}`,
      { file: destination, cause: error },
    )
  })
  if (information.isSymbolicLink() || !information.isFile()) {
    throw loaderError(
      "RALPH_RELEASE_STAGING_DESTINATION_NOT_REGULAR",
      `Staged payload must be a regular non-symlink file: ${destination}`,
      { file: destination },
    )
  }
  if (information.size <= 0 || information.size > maximumBytes) {
    throw loaderError(
      "RALPH_RELEASE_STAGING_DESTINATION_SIZE_INVALID",
      `Staged payload size is outside its declared bound: ${destination}`,
      {
        file: destination,
        details: { minimumBytes: 1, maximumBytes, actualBytes: information.size },
      },
    )
  }
  const actual = await realpath(destination)
  const relativeActual = relative(root, actual)
  if (
    relativeActual === "" ||
    relativeActual === ".." ||
    relativeActual.startsWith(`..${sep}`) ||
    isAbsolute(relativeActual)
  ) {
    throw loaderError(
      "RALPH_RELEASE_STAGING_DESTINATION_ESCAPE",
      `Materialized staging file resolves outside its operation root: ${actual}`,
      { file: actual, details: { containmentRoot: root } },
    )
  }
  const handle = await open(destination, "r")
  const hash = createHash("sha256")
  let sizeBytes = 0
  try {
    const openedInformation = await handle.stat()
    if (
      !openedInformation.isFile() ||
      openedInformation.dev !== information.dev ||
      openedInformation.ino !== information.ino
    ) {
      throw loaderError(
        "RALPH_RELEASE_STAGING_DESTINATION_CHANGED",
        `Staged payload identity changed before hashing: ${destination}`,
        { file: destination },
      )
    }
    const buffer = Buffer.allocUnsafe(256 * 1024)
    while (true) {
      const read = await handle.read(buffer, 0, buffer.byteLength, sizeBytes)
      if (read.bytesRead === 0) break
      hash.update(buffer.subarray(0, read.bytesRead))
      sizeBytes += read.bytesRead
      if (sizeBytes > maximumBytes) {
        throw loaderError(
          "RALPH_RELEASE_STAGING_DESTINATION_SIZE_INVALID",
          `Staged payload grew beyond its declared bound while hashing: ${destination}`,
          { file: destination, details: { maximumBytes, observedBytes: sizeBytes } },
        )
      }
    }
    const finalInformation = await handle.stat()
    const finalPathInformation = await lstat(destination)
    if (
      !finalInformation.isFile() ||
      finalPathInformation.isSymbolicLink() ||
      !finalPathInformation.isFile() ||
      finalInformation.dev !== finalPathInformation.dev ||
      finalInformation.ino !== finalPathInformation.ino ||
      finalInformation.size !== sizeBytes ||
      finalPathInformation.size !== sizeBytes ||
      sizeBytes !== information.size
    ) {
      throw loaderError(
        "RALPH_RELEASE_STAGING_DESTINATION_CHANGED",
        `Staged payload changed while it was being verified: ${destination}`,
        {
          file: destination,
          details: {
            initialBytes: information.size,
            hashedBytes: sizeBytes,
            finalBytes: finalInformation.size,
            finalPathBytes: finalPathInformation.size,
          },
        },
      )
    }
  } finally {
    await handle.close()
  }
  return { path: destination, sizeBytes, sha256: hash.digest("hex") }
}

async function responseForRequest(request: ReleaseFetchRequest): Promise<Response> {
  if (
    request.url.protocol !== "https:" ||
    request.url.username ||
    request.url.password ||
    request.url.search ||
    request.url.hash
  ) {
    throw loaderError(
      "RALPH_RELEASE_URL_FORBIDDEN",
      "Release downloads require an HTTPS URL without credentials, query or fragment",
      { details: { origin: request.url.origin } },
    )
  }
  const response = await fetch(request.url, {
    method: "GET",
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
    signal: request.signal ?? null,
    headers: { accept: request.acceptedMediaTypes?.join(", ") ?? "application/octet-stream" },
  }).catch((error: unknown) => {
    throw loaderError(
      "RALPH_RELEASE_DOWNLOAD_FAILED",
      `Release download failed: ${request.url.origin}${request.url.pathname}`,
      { cause: error },
    )
  })
  if (!response.ok) {
    throw loaderError(
      "RALPH_RELEASE_DOWNLOAD_HTTP_ERROR",
      `Release server returned HTTP ${response.status}: ${request.url.origin}${request.url.pathname}`,
      { details: { status: response.status } },
    )
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (
    mediaType &&
    request.acceptedMediaTypes &&
    !request.acceptedMediaTypes.some((accepted) => accepted.toLowerCase() === mediaType)
  ) {
    throw loaderError(
      "RALPH_RELEASE_MEDIA_TYPE_INVALID",
      `Release response has an unexpected content type: ${mediaType}`,
    )
  }
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > request.maximumBytes) {
    throw loaderError(
      "RALPH_RELEASE_DOWNLOAD_TOO_LARGE",
      "Release response exceeds the configured byte limit",
      { details: { maximumBytes: request.maximumBytes, declaredLength } },
    )
  }
  if (!response.body) {
    throw loaderError("RALPH_RELEASE_DOWNLOAD_EMPTY", "Release response has no body")
  }
  return response
}

export class HttpsReleaseTransport implements ReleaseTransport {
  readonly #allowedHosts: ReadonlySet<string> | undefined

  constructor(allowedHosts?: readonly string[]) {
    this.#allowedHosts = allowedHosts
      ? new Set(allowedHosts.map((host) => host.trim().toLowerCase()).filter(Boolean))
      : undefined
  }

  async fetch(request: ReleaseFetchRequest): Promise<Uint8Array> {
    const maximumBytes = validateByteLimit(request.maximumBytes)
    if (
      request.url.protocol !== "https:" ||
      request.url.username ||
      request.url.password ||
      request.url.search ||
      request.url.hash
    ) {
      throw loaderError(
        "RALPH_RELEASE_URL_FORBIDDEN",
        "Release downloads require an HTTPS URL without credentials, query or fragment",
        { details: { origin: request.url.origin } },
      )
    }
    const hostname = request.url.hostname.toLowerCase()
    if (this.#allowedHosts && !this.#allowedHosts.has(hostname)) {
      throw loaderError(
        "RALPH_RELEASE_HOST_FORBIDDEN",
        `Release host is outside the configured allowlist: ${hostname}`,
      )
    }
    const response = await responseForRequest({ ...request, maximumBytes })
    const body = response.body
    if (!body) {
      throw loaderError("RALPH_RELEASE_DOWNLOAD_EMPTY", "Release response has no body")
    }
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        length += next.value.byteLength
        if (length > maximumBytes) {
          await reader.cancel("release byte limit exceeded")
          throw loaderError(
            "RALPH_RELEASE_DOWNLOAD_TOO_LARGE",
            "Release response exceeded the configured byte limit while streaming",
            { details: { maximumBytes, observedBytes: length } },
          )
        }
        chunks.push(next.value)
      }
    } finally {
      reader.releaseLock()
    }
    const output = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      output.set(chunk, offset)
      offset += chunk.byteLength
    }
    return output
  }

  async streamToFile(
    request: ReleaseFetchRequest,
    destination: string,
  ): Promise<StagedReleasePayload> {
    const maximumBytes = validateByteLimit(request.maximumBytes)
    if (
      request.url.protocol !== "https:" ||
      request.url.username ||
      request.url.password ||
      request.url.search ||
      request.url.hash
    ) {
      throw loaderError(
        "RALPH_RELEASE_URL_FORBIDDEN",
        "Release downloads require an HTTPS URL without credentials, query or fragment",
      )
    }
    const hostname = request.url.hostname.toLowerCase()
    if (this.#allowedHosts && !this.#allowedHosts.has(hostname)) {
      throw loaderError(
        "RALPH_RELEASE_HOST_FORBIDDEN",
        `Release host is outside the configured allowlist: ${hostname}`,
      )
    }
    const response = await responseForRequest({ ...request, maximumBytes })
    const body = response.body
    if (!body) {
      throw loaderError("RALPH_RELEASE_DOWNLOAD_EMPTY", "Release response has no body")
    }
    const reader = body.getReader()
    const chunks = (async function* (): AsyncGenerator<Uint8Array> {
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) return
          yield next.value
        }
      } finally {
        reader.releaseLock()
      }
    })()
    return writeExclusiveChunks(destination, chunks, maximumBytes)
  }
}

export interface LoadedReleaseManifest {
  readonly manifest: ReleaseManifest
  readonly rawBytes: Uint8Array
  readonly sha256: string
  readonly source:
    | { readonly kind: "local"; readonly directory: string }
    | {
        readonly kind: "remote"
        readonly url: URL
      }
}

export async function loadReleaseManifest(
  origin: InstallOrigin,
  options: {
    readonly signal?: AbortSignal
    readonly transport?: ReleaseTransport
    readonly maximumBytes?: number
  } = {},
): Promise<LoadedReleaseManifest> {
  const maximumBytes = validateByteLimit(options.maximumBytes ?? DEFAULT_MANIFEST_LIMIT_BYTES)
  if (origin.kind === "local-artifact") {
    const requestedManifestPath = resolve(origin.manifestPath)
    const bytes = await readRegularFile(requestedManifestPath, maximumBytes)
    const manifestPath = await realpath(requestedManifestPath).catch((error: unknown) => {
      throw loaderError(
        "RALPH_RELEASE_MANIFEST_UNAVAILABLE",
        `Local release manifest is unavailable: ${requestedManifestPath}`,
        { file: requestedManifestPath, cause: error },
      )
    })
    return {
      manifest: parseJsonManifest(bytes, manifestPath),
      rawBytes: bytes,
      sha256: sha256Bytes(bytes),
      source: { kind: "local", directory: dirname(manifestPath) },
    }
  }
  if (origin.kind !== "standalone") {
    throw loaderError(
      "RALPH_RELEASE_MANIFEST_ORIGIN_UNSUPPORTED",
      `Install origin ${origin.kind} does not use a standalone release manifest`,
    )
  }
  const url = new URL(origin.manifestUrl)
  const transport = options.transport ?? new HttpsReleaseTransport([url.hostname])
  const bytes = await transport.fetch({
    url,
    maximumBytes,
    acceptedMediaTypes: ["application/json", "application/vnd.ralph.release+json"],
    ...(options.signal ? { signal: options.signal } : {}),
  })
  return {
    manifest: parseJsonManifest(bytes, `${url.origin}${url.pathname}`),
    rawBytes: bytes,
    sha256: sha256Bytes(bytes),
    source: { kind: "remote", url },
  }
}

export async function loadReleasePayload(
  loaded: LoadedReleaseManifest,
  payload: ReleasePayload,
  options: {
    readonly signal?: AbortSignal
    readonly transport?: ReleaseTransport
    readonly maximumBytes?: number
  } = {},
): Promise<Uint8Array> {
  const maximumBytes = validateByteLimit(
    options.maximumBytes ?? Math.min(payload.sizeBytes, DEFAULT_PAYLOAD_LIMIT_BYTES),
  )
  if (payload.sizeBytes > maximumBytes) {
    throw loaderError(
      "RALPH_RELEASE_PAYLOAD_TOO_LARGE",
      `Manifest payload exceeds the configured byte limit: ${payload.path}`,
      { details: { maximumBytes, manifestBytes: payload.sizeBytes } },
    )
  }
  let bytes: Uint8Array
  let source: string
  if (loaded.source.kind === "local") {
    const candidate = resolve(loaded.source.directory, payload.path)
    const candidateInformation = await lstat(candidate).catch((error: unknown) => {
      throw loaderError(
        "RALPH_RELEASE_PAYLOAD_UNAVAILABLE",
        `Release payload is unavailable: ${candidate}`,
        { file: candidate, cause: error },
      )
    })
    if (!candidateInformation.isFile() || candidateInformation.isSymbolicLink()) {
      throw loaderError(
        "RALPH_RELEASE_FILE_NOT_REGULAR",
        `Release payload must be a regular file: ${candidate}`,
        { file: candidate },
      )
    }
    const parent = await realpath(loaded.source.directory)
    const actual = await realpath(candidate).catch((error: unknown) => {
      throw loaderError(
        "RALPH_RELEASE_PAYLOAD_UNAVAILABLE",
        `Release payload is unavailable: ${candidate}`,
        {
          file: candidate,
          cause: error,
        },
      )
    })
    const relativePath = relative(parent, actual)
    if (
      relativePath === "" ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw loaderError(
        "RALPH_RELEASE_PAYLOAD_PATH_ESCAPE",
        `Release payload escapes its manifest directory: ${actual}`,
        { file: actual },
      )
    }
    bytes = await readRegularFile(actual, maximumBytes)
    source = actual
  } else {
    if (!payload.url) {
      throw loaderError(
        "RALPH_RELEASE_PAYLOAD_URL_MISSING",
        `Remote release payload has no HTTPS URL: ${payload.path}`,
      )
    }
    const url = new URL(payload.url)
    const transport = options.transport ?? new HttpsReleaseTransport([loaded.source.url.hostname])
    bytes = await transport.fetch({
      url,
      maximumBytes,
      acceptedMediaTypes: [payload.mediaType, "application/octet-stream"],
      ...(options.signal ? { signal: options.signal } : {}),
    })
    source = `${url.origin}${url.pathname}`
  }
  verifyReleasePayloadBytes(payload, bytes, source)
  return bytes
}

type ReleaseBlobDescriptor = {
  readonly path: string
  readonly url?: string
  readonly mediaType: string
}

function releaseBlobDescriptor(payload: {
  readonly path: string
  readonly url?: string | undefined
  readonly mediaType: string
}): ReleaseBlobDescriptor {
  return {
    path: payload.path,
    ...(payload.url !== undefined ? { url: payload.url } : {}),
    mediaType: payload.mediaType,
  }
}

async function stageReleaseBlob(
  loaded: LoadedReleaseManifest,
  payload: ReleaseBlobDescriptor,
  destination: string,
  options: {
    readonly containmentRoot: string
    readonly signal?: AbortSignal
    readonly transport?: ReleaseTransport
    readonly maximumBytes?: number
  },
  declaredMaximumBytes: number,
  expected?: { readonly sizeBytes: number; readonly sha256: string },
): Promise<StagedReleasePayload> {
  const maximumBytes = validateByteLimit(
    options.maximumBytes ?? Math.min(declaredMaximumBytes, DEFAULT_PAYLOAD_LIMIT_BYTES),
  )
  if (declaredMaximumBytes > maximumBytes) {
    throw loaderError(
      "RALPH_RELEASE_PAYLOAD_TOO_LARGE",
      `Manifest payload exceeds the configured byte limit: ${payload.path}`,
      { details: { maximumBytes, manifestMaximumBytes: declaredMaximumBytes } },
    )
  }
  const root = await realpath(resolve(options.containmentRoot)).catch((error: unknown) => {
    throw loaderError(
      "RALPH_RELEASE_STAGING_ROOT_INVALID",
      `Release staging root is unavailable: ${resolve(options.containmentRoot)}`,
      { file: resolve(options.containmentRoot), cause: error },
    )
  })
  const requestedDestination = resolve(destination)
  const parent = await realpath(dirname(requestedDestination)).catch((error: unknown) => {
    throw loaderError(
      "RALPH_RELEASE_STAGING_PARENT_INVALID",
      `Release staging parent is unavailable: ${dirname(requestedDestination)}`,
      { file: dirname(requestedDestination), cause: error },
    )
  })
  const relativeDestination = relative(root, requestedDestination)
  const parentRelative = relative(root, parent)
  if (
    relativeDestination === "" ||
    relativeDestination === ".." ||
    relativeDestination.startsWith(`..${sep}`) ||
    isAbsolute(relativeDestination) ||
    parentRelative === ".." ||
    parentRelative.startsWith(`..${sep}`) ||
    isAbsolute(parentRelative)
  ) {
    throw loaderError(
      "RALPH_RELEASE_STAGING_PATH_ESCAPE",
      `Release staging destination escapes its operation root: ${requestedDestination}`,
      { file: requestedDestination, details: { containmentRoot: root } },
    )
  }

  let staged: StagedReleasePayload
  let source: string
  if (loaded.source.kind === "local") {
    const candidate = resolve(loaded.source.directory, payload.path)
    const manifestDirectory = await realpath(loaded.source.directory)
    const candidateInformation = await lstat(candidate).catch((error: unknown) => {
      throw loaderError(
        "RALPH_RELEASE_PAYLOAD_UNAVAILABLE",
        `Release payload is unavailable: ${candidate}`,
        { file: candidate, cause: error },
      )
    })
    if (!candidateInformation.isFile() || candidateInformation.isSymbolicLink()) {
      throw loaderError(
        "RALPH_RELEASE_FILE_NOT_REGULAR",
        `Release payload must be a regular file: ${candidate}`,
        { file: candidate },
      )
    }
    const actual = await realpath(candidate).catch((error: unknown) => {
      throw loaderError(
        "RALPH_RELEASE_PAYLOAD_UNAVAILABLE",
        `Release payload is unavailable: ${candidate}`,
        { file: candidate, cause: error },
      )
    })
    const relativeSource = relative(manifestDirectory, actual)
    if (
      relativeSource === "" ||
      relativeSource === ".." ||
      relativeSource.startsWith(`..${sep}`) ||
      isAbsolute(relativeSource)
    ) {
      throw loaderError(
        "RALPH_RELEASE_PAYLOAD_PATH_ESCAPE",
        `Release payload escapes its manifest directory: ${actual}`,
        { file: actual },
      )
    }
    const chunks = (async function* (): AsyncGenerator<Uint8Array> {
      for await (const chunk of createReadStream(actual)) {
        yield new Uint8Array(chunk)
      }
    })()
    staged = await writeExclusiveChunks(requestedDestination, chunks, maximumBytes)
    source = actual
  } else {
    if (!payload.url) {
      throw loaderError(
        "RALPH_RELEASE_PAYLOAD_URL_MISSING",
        `Remote release payload has no HTTPS URL: ${payload.path}`,
      )
    }
    const url = new URL(payload.url)
    const transport = options.transport ?? new HttpsReleaseTransport([loaded.source.url.hostname])
    const request: ReleaseFetchRequest = {
      url,
      maximumBytes,
      acceptedMediaTypes: [payload.mediaType, "application/octet-stream"],
      ...(options.signal ? { signal: options.signal } : {}),
    }
    if (transport.streamToFile) {
      const transportResult = await transport.streamToFile(request, requestedDestination)
      if (
        !transportResult ||
        typeof transportResult.path !== "string" ||
        resolve(transportResult.path) !== requestedDestination
      ) {
        await unlink(requestedDestination).catch(() => undefined)
        throw loaderError(
          "RALPH_RELEASE_TRANSPORT_DESTINATION_DIVERGED",
          "Release transport returned a staging path other than the caller-selected destination",
          {
            file: requestedDestination,
            details: {
              requestedDestination,
              returnedPath:
                transportResult && typeof transportResult.path === "string"
                  ? transportResult.path
                  : "<invalid>",
            },
          },
        )
      }
      staged = await inspectStagedDestination(requestedDestination, root, maximumBytes)
    } else {
      const bytes = await transport.fetch(request)
      const chunks = (async function* (): AsyncGenerator<Uint8Array> {
        yield bytes
      })()
      staged = await writeExclusiveChunks(requestedDestination, chunks, maximumBytes)
    }
    source = `${url.origin}${url.pathname}`
  }
  if (resolve(staged.path) !== requestedDestination) {
    await unlink(requestedDestination).catch(() => undefined)
    throw loaderError(
      "RALPH_RELEASE_STAGING_DESTINATION_DIVERGED",
      "Staged payload did not remain at the caller-selected destination",
      { file: requestedDestination, details: { returnedPath: staged.path } },
    )
  }
  const verifiedStaged = await inspectStagedDestination(requestedDestination, root, maximumBytes)
  if (
    verifiedStaged.sizeBytes <= 0 ||
    (expected && verifiedStaged.sizeBytes !== expected.sizeBytes)
  ) {
    await unlink(requestedDestination).catch(() => undefined)
    throw loaderError(
      "RALPH_RELEASE_PAYLOAD_SIZE_MISMATCH",
      `Release payload size does not match manifest: ${source}`,
      {
        file: requestedDestination,
        details: {
          ...(expected ? { expected: expected.sizeBytes } : { minimum: 1 }),
          actual: verifiedStaged.sizeBytes,
        },
      },
    )
  }
  if (expected && verifiedStaged.sha256 !== expected.sha256.toLowerCase()) {
    await unlink(requestedDestination).catch(() => undefined)
    throw loaderError(
      "RALPH_RELEASE_PAYLOAD_HASH_MISMATCH",
      `Release payload SHA-256 does not match manifest: ${source}`,
      {
        file: requestedDestination,
        details: { expected: expected.sha256, actual: verifiedStaged.sha256 },
      },
    )
  }
  return verifiedStaged
}

export async function stageReleasePayload(
  loaded: LoadedReleaseManifest,
  payload: ReleasePayload,
  destination: string,
  options: {
    readonly containmentRoot: string
    readonly signal?: AbortSignal
    readonly transport?: ReleaseTransport
    readonly maximumBytes?: number
  },
): Promise<StagedReleasePayload> {
  return stageReleaseBlob(
    loaded,
    releaseBlobDescriptor(payload),
    destination,
    options,
    payload.sizeBytes,
    {
      sizeBytes: payload.sizeBytes,
      sha256: payload.sha256,
    },
  )
}

export async function stageDetachedSignaturePayload(
  loaded: LoadedReleaseManifest,
  payload: {
    readonly path: string
    readonly url?: string | undefined
    readonly maximumSizeBytes: number
    readonly mediaType: string
  },
  destination: string,
  options: {
    readonly containmentRoot: string
    readonly signal?: AbortSignal
    readonly transport?: ReleaseTransport
    readonly maximumBytes?: number
  },
): Promise<StagedReleasePayload> {
  return stageReleaseBlob(
    loaded,
    releaseBlobDescriptor(payload),
    destination,
    options,
    payload.maximumSizeBytes,
  )
}
