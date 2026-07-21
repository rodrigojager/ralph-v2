import { createHash } from "node:crypto"
import { lstat, open, readFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { EXIT_CODES, type ExitCode, RalphError } from "@ralph/domain"
import {
  canonicalDirectory,
  loadEffectiveConfig,
  readConfigTransferLayer,
  writeFileAtomic,
} from "@ralph/persistence"
import { REDACTED, redactValue, secretValuesFromEnvironment } from "@ralph/telemetry"
import { LineCounter, parseDocument, stringify } from "yaml"

export type ConfigDocumentSerialization = "yaml" | "json"
export type ConfigExportScope = "workspace" | "global" | "effective"

export type ConfigEditorCommandRequest = {
  readonly scope: "workspace" | "global"
  readonly path: string
  readonly serialization: "yaml"
  readonly document: string
  readonly signal?: AbortSignal
}

export type ConfigEditorCommandResponse =
  | { readonly status: "submitted"; readonly document: string }
  | { readonly status: "cancelled" }

/**
 * An application-owned editor boundary. The commands/domain layer supplies a
 * bounded, redacted document and validates the returned candidate; it never
 * spawns an executable or trusts editor output directly.
 */
export interface ConfigEditorCommandService {
  edit(request: ConfigEditorCommandRequest): Promise<ConfigEditorCommandResponse>
}

export type ConfigTransferInput = {
  readonly path: string
  readonly document: string
  readonly value: unknown
  readonly bytes: number
  readonly sha256: string
}

type ConfigExportResultBase = {
  readonly scope: ConfigExportScope
  readonly serialization: ConfigDocumentSerialization
  readonly policy: "redacted-no-secret-resolution"
  readonly sourcePath: string | null
  readonly sha256: string
  readonly bytes: number
}

export type ConfigExportResult = ConfigExportResultBase &
  (
    | {
        readonly output: null
        readonly overwritten: false
        readonly document: string
      }
    | {
        readonly output: string
        readonly overwritten: boolean
      }
  )

const MAX_CONFIG_TRANSFER_BYTES = 1024 * 1024
const PRIVATE_KEY_PATTERN =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g
const TOKEN_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g,
] as const

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function contained(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function redactTokenShapedText(value: unknown): unknown {
  if (typeof value === "string") {
    let output = value.replace(PRIVATE_KEY_PATTERN, REDACTED)
    for (const pattern of TOKEN_VALUE_PATTERNS) output = output.replace(pattern, REDACTED)
    return output
  }
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(redactTokenShapedText)
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactTokenShapedText(item)]),
  )
}

function restoreSafeEnvironmentReferences(
  original: unknown,
  redacted: unknown,
  path: readonly string[] = [],
): unknown {
  if (
    typeof original === "string" &&
    path[path.length - 2] === "environment_refs" &&
    /^env:[A-Za-z_][A-Za-z0-9_]*$/.test(original)
  ) {
    return original
  }
  if (
    original === null ||
    redacted === null ||
    typeof original !== "object" ||
    typeof redacted !== "object"
  ) {
    return redacted
  }
  if (Array.isArray(original)) {
    if (!Array.isArray(redacted)) return redacted
    return redacted.map((item, index) =>
      restoreSafeEnvironmentReferences(original[index], item, [...path, String(index)]),
    )
  }
  if (Array.isArray(redacted)) return redacted
  return Object.fromEntries(
    Object.entries(redacted).map(([key, item]) => [
      key,
      restoreSafeEnvironmentReferences((original as Record<string, unknown>)[key], item, [
        ...path,
        key,
      ]),
    ]),
  )
}

function safeExportValue(value: unknown, environment: Record<string, string | undefined>): unknown {
  const redacted = redactValue(value, secretValuesFromEnvironment(environment))
  return redactTokenShapedText(restoreSafeEnvironmentReferences(value, redacted))
}

function serializeConfigDocument(
  value: unknown,
  serialization: ConfigDocumentSerialization,
): string {
  return serialization === "json"
    ? `${JSON.stringify(value, null, 2)}\n`
    : stringify(value, { indent: 2, lineWidth: 100 })
}

function configTransferError(
  code: string,
  message: string,
  options: {
    file?: string
    line?: number
    column?: number
    hint?: string
    details?: Record<string, unknown>
    exitCode?: ExitCode
    cause?: unknown
  } = {},
): never {
  throw new RalphError(code, message, {
    exitCode: options.exitCode ?? EXIT_CODES.invalidUsage,
    ...(options.file ? { file: options.file } : {}),
    ...(options.line ? { line: options.line } : {}),
    ...(options.column ? { column: options.column } : {}),
    ...(options.hint ? { hint: options.hint } : {}),
    ...(options.details ? { details: options.details } : {}),
    ...(options.cause ? { cause: options.cause } : {}),
  })
}

function parseConfigTransferDocument(document: string, path: string): unknown {
  if (document.includes("\0")) {
    return configTransferError(
      "RALPH_CONFIG_TRANSFER_NUL_FORBIDDEN",
      "Configuration transfer cannot contain NUL bytes",
      { file: path },
    )
  }
  const lineCounter = new LineCounter()
  const parsed = parseDocument(document, {
    lineCounter,
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  })
  if (parsed.errors.length > 0) {
    const first = parsed.errors[0]
    const location = first?.linePos?.[0]
    return configTransferError(
      "RALPH_CONFIG_TRANSFER_DOCUMENT_INVALID",
      "Configuration transfer is not valid strict YAML or JSON",
      {
        file: path,
        ...(location?.line ? { line: location.line } : {}),
        ...(location?.col ? { column: location.col } : {}),
      },
    )
  }
  try {
    return parsed.toJS({ maxAliasCount: 50 })
  } catch {
    return configTransferError(
      "RALPH_CONFIG_TRANSFER_DOCUMENT_UNSAFE",
      "Configuration transfer exceeds the safe YAML alias/structure limits",
      { file: path },
    )
  }
}

async function readStableConfigTransferBytes(
  path: string,
  initial: Awaited<ReturnType<typeof lstat>>,
): Promise<Buffer> {
  const handle = await open(path, "r").catch((error: unknown) =>
    configTransferError(
      "RALPH_CONFIG_TRANSFER_INPUT_UNAVAILABLE",
      "Configuration transfer input could not be opened",
      { file: path, cause: error },
    ),
  )
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.dev !== initial.dev ||
      opened.ino !== initial.ino ||
      opened.size !== initial.size
    ) {
      return configTransferError(
        "RALPH_CONFIG_TRANSFER_INPUT_CHANGED",
        "Configuration transfer input identity changed before it was read",
        { file: path, exitCode: EXIT_CODES.conflict },
      )
    }

    const buffer = Buffer.allocUnsafe(MAX_CONFIG_TRANSFER_BYTES + 1)
    let size = 0
    while (size < buffer.byteLength) {
      const read = await handle.read(buffer, size, buffer.byteLength - size, size)
      if (read.bytesRead === 0) break
      size += read.bytesRead
    }
    if (size > MAX_CONFIG_TRANSFER_BYTES) {
      return configTransferError(
        "RALPH_CONFIG_TRANSFER_INPUT_TOO_LARGE",
        "Configuration transfer input exceeded the bounded size limit while it was read",
        {
          file: path,
          details: { size, maximumBytes: MAX_CONFIG_TRANSFER_BYTES },
        },
      )
    }

    const finalOpened = await handle.stat()
    const finalPath = await lstat(path).catch((error: unknown) =>
      configTransferError(
        "RALPH_CONFIG_TRANSFER_INPUT_CHANGED",
        "Configuration transfer input disappeared while it was read",
        { file: path, exitCode: EXIT_CODES.conflict, cause: error },
      ),
    )
    if (
      !finalOpened.isFile() ||
      !finalPath.isFile() ||
      finalPath.isSymbolicLink() ||
      finalOpened.dev !== opened.dev ||
      finalOpened.ino !== opened.ino ||
      finalPath.dev !== opened.dev ||
      finalPath.ino !== opened.ino ||
      finalOpened.size !== size ||
      finalPath.size !== size ||
      opened.size !== size ||
      finalOpened.mtimeMs !== opened.mtimeMs ||
      finalOpened.ctimeMs !== opened.ctimeMs
    ) {
      return configTransferError(
        "RALPH_CONFIG_TRANSFER_INPUT_CHANGED",
        "Configuration transfer input changed while it was read",
        {
          file: path,
          exitCode: EXIT_CODES.conflict,
          details: {
            initialBytes: initial.size,
            readBytes: size,
            finalBytes: finalOpened.size,
            finalPathBytes: finalPath.size,
          },
        },
      )
    }
    return buffer.subarray(0, size)
  } finally {
    await handle.close()
  }
}

export async function readConfigTransferInput(
  requestedPath: string,
  cwd: string,
): Promise<ConfigTransferInput> {
  const path = resolve(cwd, requestedPath)
  let entry: Awaited<ReturnType<typeof lstat>>
  try {
    entry = await lstat(path)
  } catch (error) {
    return configTransferError(
      "RALPH_CONFIG_TRANSFER_INPUT_UNAVAILABLE",
      "Configuration transfer input could not be inspected",
      { file: path, cause: error },
    )
  }
  if (!entry.isFile() || entry.isSymbolicLink()) {
    return configTransferError(
      "RALPH_CONFIG_TRANSFER_INPUT_UNSAFE",
      "Configuration transfer input must be an explicitly named regular non-linked file",
      { file: path, exitCode: EXIT_CODES.policyDenied },
    )
  }
  if (entry.size > MAX_CONFIG_TRANSFER_BYTES) {
    return configTransferError(
      "RALPH_CONFIG_TRANSFER_INPUT_TOO_LARGE",
      "Configuration transfer input exceeds the bounded size limit",
      {
        file: path,
        details: { size: entry.size, maximumBytes: MAX_CONFIG_TRANSFER_BYTES },
      },
    )
  }
  const bytes = await readStableConfigTransferBytes(path, entry)
  let document: string
  try {
    document = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (error) {
    return configTransferError(
      "RALPH_CONFIG_TRANSFER_INPUT_ENCODING_INVALID",
      "Configuration transfer input must be valid UTF-8",
      { file: path, cause: error },
    )
  }
  return {
    path,
    document,
    value: parseConfigTransferDocument(document, path),
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  }
}

type OutputSnapshot = { exists: false } | { exists: true; sha256: string }

async function outputSnapshot(path: string): Promise<OutputSnapshot> {
  try {
    const entry = await lstat(path)
    if (!entry.isFile() || entry.isSymbolicLink()) {
      return configTransferError(
        "RALPH_CONFIG_EXPORT_OUTPUT_UNSAFE",
        "Configuration export output must be a regular non-linked file",
        { file: path, exitCode: EXIT_CODES.policyDenied },
      )
    }
    return { exists: true, sha256: sha256(await readFile(path)) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false }
    throw error
  }
}

function sameOutputSnapshot(left: OutputSnapshot, right: OutputSnapshot): boolean {
  if (left.exists !== right.exists) return false
  return !left.exists || (right.exists && left.sha256 === right.sha256)
}

export async function exportConfigTransfer(options: {
  readonly scope: ConfigExportScope
  readonly serialization: ConfigDocumentSerialization
  readonly workspaceRoot?: string
  readonly environment: Record<string, string | undefined>
  readonly outputBase: string
  readonly output?: string
  readonly force: boolean
}): Promise<ConfigExportResult> {
  let sourcePath: string | null
  let source: unknown
  if (options.scope === "effective") {
    const effective = await loadEffectiveConfig({
      ...(options.workspaceRoot
        ? { workspaceConfig: resolve(options.workspaceRoot, ".ralph", "config.yaml") }
        : {}),
      environment: options.environment,
    })
    source = effective.config
    sourcePath = null
  } else {
    const loaded = await readConfigTransferLayer({
      scope: options.scope,
      ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
      environment: options.environment,
    })
    source = loaded.layer
    sourcePath = loaded.path
  }
  const document = serializeConfigDocument(
    safeExportValue(source, options.environment),
    options.serialization,
  )
  const digest = sha256(document)
  const bytes = new TextEncoder().encode(document).byteLength
  if (!options.output) {
    return {
      scope: options.scope,
      serialization: options.serialization,
      policy: "redacted-no-secret-resolution",
      sourcePath,
      output: null,
      sha256: digest,
      bytes,
      overwritten: false,
      document,
    }
  }

  const base = await canonicalDirectory(options.outputBase)
  const requested = resolve(base, options.output)
  const parent = await canonicalDirectory(dirname(requested))
  const target = resolve(parent, basename(requested))
  if (!contained(base, target) || target === base) {
    return configTransferError(
      "RALPH_CONFIG_EXPORT_OUTSIDE_BASE",
      "Configuration export output must stay inside the selected workspace/current directory",
      { file: target, exitCode: EXIT_CODES.policyDenied },
    )
  }
  const baseline = await outputSnapshot(target)
  if (baseline.exists && !options.force) {
    return configTransferError(
      "RALPH_CONFIG_EXPORT_EXISTS",
      "Configuration export refuses to overwrite an existing file without --force",
      { file: target, exitCode: EXIT_CODES.policyDenied },
    )
  }
  await writeFileAtomic(target, document, {
    overwrite: baseline.exists,
    mode: 0o600,
    beforeCommit: async () => {
      const observed = await outputSnapshot(target)
      if (!sameOutputSnapshot(baseline, observed)) {
        return configTransferError(
          "RALPH_CONFIG_EXPORT_CONFLICT",
          "Configuration export output changed before the atomic commit",
          { file: target, exitCode: EXIT_CODES.conflict },
        )
      }
    },
  })
  return {
    scope: options.scope,
    serialization: options.serialization,
    policy: "redacted-no-secret-resolution",
    sourcePath,
    output: target,
    sha256: digest,
    bytes,
    overwritten: baseline.exists,
  }
}

export async function editableConfigDocument(options: {
  readonly scope: "workspace" | "global"
  readonly workspaceRoot?: string
  readonly environment: Record<string, string | undefined>
}): Promise<{ path: string; document: string; expectedTargetSha256: string | null }> {
  const loaded = await readConfigTransferLayer({
    scope: options.scope,
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    environment: options.environment,
  })
  const managedLayer = structuredClone(loaded.layer) as Record<string, unknown>
  // Extension payloads belong to their explicit trusted owner. They are not
  // presented to the generic editor and remain untouched by replace-managed.
  delete managedLayer.extensions
  const document = serializeConfigDocument(
    safeExportValue(managedLayer, options.environment),
    "yaml",
  )
  const bytes = new TextEncoder().encode(document).byteLength
  if (bytes > MAX_CONFIG_TRANSFER_BYTES) {
    return configTransferError(
      "RALPH_CONFIG_EDIT_SOURCE_TOO_LARGE",
      "Configuration layer is too large for the bounded editor contract",
      {
        file: loaded.path,
        details: { bytes, maximumBytes: MAX_CONFIG_TRANSFER_BYTES },
      },
    )
  }
  return {
    path: loaded.path,
    document,
    expectedTargetSha256: loaded.sha256,
  }
}

export function parseEditedConfigDocument(document: string, path: string): unknown {
  const bytes = new TextEncoder().encode(document).byteLength
  if (bytes > MAX_CONFIG_TRANSFER_BYTES) {
    return configTransferError(
      "RALPH_CONFIG_EDIT_RESULT_TOO_LARGE",
      "Edited configuration exceeds the bounded size limit",
      { file: path, details: { bytes, maximumBytes: MAX_CONFIG_TRANSFER_BYTES } },
    )
  }
  return parseConfigTransferDocument(document, path)
}
