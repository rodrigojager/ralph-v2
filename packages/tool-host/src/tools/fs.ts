import { randomUUID } from "node:crypto"
import type { Stats } from "node:fs"
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import { z } from "zod"
import { Sha256Schema, type ToolEffect } from "../contracts"
import { ToolHostError } from "../errors"
import { sha256 } from "../hash"
import type { ResolvedWorkspacePath, WorkspacePathResolver } from "../path-resolver"
import { jsonInputSchema, type RegisteredTool, type ToolRuntimeContext } from "../registry"

const PortablePathSchema = z.string().min(1).max(4_096)
const OffsetSchema = z.number().int().nonnegative()

export const FsReadInputSchema = z
  .object({
    path: PortablePathSchema,
    offsetBytes: OffsetSchema.default(0),
    limitBytes: z.number().int().positive().optional(),
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
  })
  .strict()

export const FsListInputSchema = z
  .object({
    path: PortablePathSchema.default("."),
    recursive: z.boolean().default(false),
    maxDepth: z.number().int().nonnegative().default(1),
    limit: z.number().int().positive().optional(),
  })
  .strict()

export const FsGlobInputSchema = z
  .object({
    path: PortablePathSchema.default("."),
    pattern: z.string().min(1).max(4_096),
    limit: z.number().int().positive().optional(),
  })
  .strict()

export const FsSearchInputSchema = z
  .object({
    path: PortablePathSchema.default("."),
    query: z.string().min(1).max(4_096),
    caseSensitive: z.boolean().default(true),
    filePattern: z.string().min(1).max(4_096).default("**/*"),
    maxMatches: z.number().int().positive().optional(),
  })
  .strict()

export const FilePreconditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }).strict(),
  z.object({ kind: z.literal("sha256"), value: Sha256Schema }).strict(),
])

export const FsWriteInputSchema = z
  .object({
    path: PortablePathSchema,
    content: z.string(),
    precondition: FilePreconditionSchema,
    createParents: z.boolean().default(false),
  })
  .strict()

export const TextReplacementSchema = z
  .object({
    oldText: z.string().min(1),
    newText: z.string(),
    all: z.boolean().default(false),
  })
  .strict()

export const FsEditInputSchema = z
  .object({
    path: PortablePathSchema,
    beforeSha256: Sha256Schema,
    replacements: z.array(TextReplacementSchema).min(1).max(256),
  })
  .strict()

const StructuredPatchChangeSchema = z
  .object({
    path: PortablePathSchema,
    beforeSha256: Sha256Schema,
    replacements: z.array(TextReplacementSchema).min(1).max(256),
  })
  .strict()

export const FsApplyPatchInputSchema = z
  .object({
    changes: z.array(StructuredPatchChangeSchema).min(1).max(128),
    description: z.string().max(4_096).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>()
    for (const [index, change] of value.changes.entries()) {
      const key = process.platform === "win32" ? change.path.toLocaleLowerCase("und") : change.path
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          message: "Structured patch contains the same path more than once",
          path: ["changes", index, "path"],
        })
      }
      seen.add(key)
    }
  })

type StableFile = {
  bytes: Uint8Array
  sha256: string
  metadata: Stats
}

function metadataFingerprint(metadata: Stats): string {
  return [
    metadata.dev,
    metadata.ino,
    metadata.mode,
    metadata.size,
    metadata.mtimeMs,
    metadata.ctimeMs,
  ].join(":")
}

function throwIfCancelled(context: ToolRuntimeContext): void {
  if (context.session.signal?.aborted) {
    throw new ToolHostError(
      "RALPH_TOOL_CANCELLED",
      "Tool call was cancelled",
      "cancelled",
      "reconcile-by-precondition",
      true,
    )
  }
  if (context.session.deadlineAt && Date.now() >= Date.parse(context.session.deadlineAt)) {
    throw new ToolHostError(
      "RALPH_TOOL_DEADLINE_EXCEEDED",
      "Tool call exceeded the task deadline",
      "timeout",
      "reconcile-by-precondition",
      true,
    )
  }
}

async function stableFile(path: ResolvedWorkspacePath, maximumBytes: number): Promise<StableFile> {
  if (!path.exists || path.kind !== "file") {
    throw new ToolHostError(
      "RALPH_TOOL_FILE_REQUIRED",
      `Regular file required: ${path.portablePath}`,
    )
  }
  const beforePath = await lstat(path.absolutePath)
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) {
    throw new ToolHostError("RALPH_TOOL_FILE_CHANGED", `File changed type: ${path.portablePath}`)
  }
  if (beforePath.size > maximumBytes) {
    throw new ToolHostError(
      "RALPH_TOOL_FILE_TOO_LARGE",
      `File exceeds the ${maximumBytes} byte tool limit: ${path.portablePath}`,
      "error",
      "safe-to-retry",
    )
  }
  const handle = await open(path.absolutePath, "r")
  try {
    const beforeHandle = await handle.stat()
    if (metadataFingerprint(beforePath) !== metadataFingerprint(beforeHandle)) {
      throw new ToolHostError(
        "RALPH_TOOL_FILE_CHANGED",
        `File was replaced before it could be read: ${path.portablePath}`,
        "error",
        "safe-to-retry",
        true,
      )
    }
    const bytes = await handle.readFile()
    const afterHandle = await handle.stat()
    const afterPath = await lstat(path.absolutePath)
    if (
      bytes.byteLength !== afterHandle.size ||
      metadataFingerprint(beforeHandle) !== metadataFingerprint(afterHandle) ||
      metadataFingerprint(afterHandle) !== metadataFingerprint(afterPath)
    ) {
      throw new ToolHostError(
        "RALPH_TOOL_FILE_CHANGED",
        `File changed while it was being read: ${path.portablePath}`,
        "error",
        "safe-to-retry",
        true,
      )
    }
    return { bytes, sha256: sha256(bytes), metadata: afterPath }
  } finally {
    await handle.close()
  }
}

function utf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch (error) {
    throw new ToolHostError(
      "RALPH_TOOL_FILE_UTF8_INVALID",
      `File is not valid UTF-8: ${path}`,
      "error",
      "safe-to-retry",
      false,
      { cause: error },
    )
  }
}

function replacementResult(
  source: string,
  replacements: readonly z.infer<typeof TextReplacementSchema>[],
  path: string,
): string {
  let output = source
  for (const [index, replacement] of replacements.entries()) {
    const first = output.indexOf(replacement.oldText)
    if (first < 0) {
      throw new ToolHostError(
        "RALPH_TOOL_EDIT_TEXT_NOT_FOUND",
        `Replacement ${index + 1} did not match ${path}`,
        "error",
        "reconcile-by-precondition",
        true,
      )
    }
    if (replacement.all) {
      output = output.split(replacement.oldText).join(replacement.newText)
      continue
    }
    if (output.indexOf(replacement.oldText, first + replacement.oldText.length) >= 0) {
      throw new ToolHostError(
        "RALPH_TOOL_EDIT_TEXT_AMBIGUOUS",
        `Replacement ${index + 1} matches more than once in ${path}`,
        "error",
        "reconcile-by-precondition",
      )
    }
    output = `${output.slice(0, first)}${replacement.newText}${output.slice(
      first + replacement.oldText.length,
    )}`
  }
  return output
}

async function ensureParent(
  resolver: WorkspacePathResolver,
  target: ResolvedWorkspacePath,
  createParents: boolean,
): Promise<void> {
  const parentPortable = target.portablePath.includes("/")
    ? target.portablePath.slice(0, target.portablePath.lastIndexOf("/"))
    : "."
  try {
    const parent = await resolver.resolve(parentPortable, "write", {
      mustExist: true,
      allowRoot: true,
    })
    if (parent.kind !== "directory") throw new Error("parent is not a directory")
    return
  } catch (error) {
    if (!createParents) throw error
  }

  const segments = parentPortable === "." ? [] : parentPortable.split("/")
  let current = "."
  for (const segment of segments) {
    current = current === "." ? segment : `${current}/${segment}`
    try {
      const existing = await resolver.resolve(current, "write", {
        mustExist: true,
        allowRoot: true,
      })
      if (existing.kind !== "directory") {
        throw new ToolHostError(
          "RALPH_TOOL_PARENT_NOT_DIRECTORY",
          `Write parent is not a directory: ${current}`,
        )
      }
    } catch (error) {
      if (!(error instanceof ToolHostError) || error.code !== "RALPH_TOOL_PATH_MISSING") throw error
      const candidate = await resolver.resolve(current, "write", { allowRoot: true })
      await resolver.revalidate(candidate)
      await mkdir(candidate.absolutePath, { recursive: false, mode: 0o700 })
      const created = await resolver.resolve(current, "write", { mustExist: true, allowRoot: true })
      if (created.kind !== "directory") {
        throw new ToolHostError(
          "RALPH_TOOL_PARENT_NOT_DIRECTORY",
          `Created write parent is not a directory: ${current}`,
        )
      }
    }
  }
}

async function atomicWrite(
  resolver: WorkspacePathResolver,
  resolved: ResolvedWorkspacePath,
  bytes: Uint8Array,
): Promise<string> {
  const revalidateAfterStaging = await resolver.guardParentDirectoryMetadataMutation(resolved)
  const parent = dirname(resolved.absolutePath)
  const temporary = resolve(parent, `.ralph-tool-${randomUUID()}.tmp`)
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await revalidateAfterStaging()
    await rename(temporary, resolved.absolutePath)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
  const after = await resolver.resolve(resolved.portablePath, "write", { mustExist: true })
  if (after.kind !== "file") {
    throw new ToolHostError(
      "RALPH_TOOL_WRITE_NOT_REGULAR",
      `Write did not produce a regular file: ${resolved.portablePath}`,
      "error",
      "manual-review",
    )
  }
  return (await stableFile(after, bytes.byteLength)).sha256
}

function readAssessment(path: string, context: ToolRuntimeContext) {
  return {
    facts: {
      risk: "read" as const,
      mutatesWorkspace: false,
      pathProtected: context.resolver.isProtected(path),
      pathInReadScope: context.resolver.isInScope(path, "read"),
      pathInWriteScope: false,
      shell: false,
    },
    reason: `Read access requested for ${path}`,
  }
}

function writeAssessment(paths: readonly string[], context: ToolRuntimeContext) {
  return {
    facts: {
      risk: "write" as const,
      mutatesWorkspace: true,
      pathProtected: paths.some((path) => context.resolver.isProtected(path)),
      pathInReadScope: paths.every((path) => context.resolver.isInScope(path, "read")),
      pathInWriteScope: paths.every((path) => context.resolver.isInScope(path, "write")),
      shell: false,
    },
    reason: `Preconditioned write requested for ${paths.join(", ")}`,
  }
}

function assertPattern(pattern: string): void {
  if (
    pattern.includes("\\") ||
    pattern.startsWith("/") ||
    /^[A-Za-z]:/.test(pattern) ||
    pattern.split("/").includes("..") ||
    pattern.includes("\0")
  ) {
    throw new ToolHostError(
      "RALPH_TOOL_GLOB_INVALID",
      "Glob patterns must be portable, relative, and cannot traverse parents",
      "invalid",
      "safe-to-retry",
    )
  }
}

async function listEntries(
  input: z.infer<typeof FsListInputSchema>,
  context: ToolRuntimeContext,
): Promise<Array<{ path: string; kind: string; sizeBytes?: number }>> {
  const root = await context.resolver.resolve(input.path, "read", {
    mustExist: true,
    allowRoot: true,
  })
  if (root.kind !== "directory") {
    throw new ToolHostError("RALPH_TOOL_DIRECTORY_REQUIRED", `Directory required: ${input.path}`)
  }
  const maximum = Math.min(
    input.limit ?? context.policy.limits.maxListEntries,
    context.policy.limits.maxListEntries,
  )
  const output: Array<{ path: string; kind: string; sizeBytes?: number }> = []
  const walk = async (absolute: string, depth: number): Promise<void> => {
    throwIfCancelled(context)
    const entries = await readdir(absolute, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (output.length >= maximum) return
      const target = resolve(absolute, entry.name)
      const path = relative(context.resolver.root, target).replaceAll("\\", "/")
      if (context.resolver.isProtected(path) || !context.resolver.isInScope(path, "read")) continue
      const metadata = await lstat(target)
      const kind = metadata.isSymbolicLink()
        ? "symlink"
        : metadata.isDirectory()
          ? "directory"
          : metadata.isFile()
            ? "file"
            : "other"
      output.push({ path, kind, ...(metadata.isFile() ? { sizeBytes: metadata.size } : {}) })
      if (
        input.recursive &&
        depth < input.maxDepth &&
        metadata.isDirectory() &&
        !metadata.isSymbolicLink()
      ) {
        await walk(target, depth + 1)
      }
    }
  }
  await walk(root.canonicalPath ?? root.absolutePath, 0)
  return output
}

function makeDefinition(
  name: string,
  description: string,
  schema: z.ZodType,
  risk: "read" | "write",
  mutatesWorkspace: boolean,
) {
  return {
    schemaVersion: 1 as const,
    name,
    description,
    inputSchema: jsonInputSchema(schema),
    risk,
    mutatesWorkspace,
  }
}

export function filesystemTools(): readonly RegisteredTool[] {
  const read: RegisteredTool = {
    definition: makeDefinition(
      "fs.read",
      "Read a bounded byte range from a regular workspace file and return its hash.",
      FsReadInputSchema,
      "read",
      false,
    ),
    inputSchema: FsReadInputSchema,
    assess(input, context) {
      const parsed = FsReadInputSchema.parse(input)
      return readAssessment(parsed.path, context)
    },
    async execute(input, context) {
      const parsed = FsReadInputSchema.parse(input)
      throwIfCancelled(context)
      const resolved = await context.resolver.resolve(parsed.path, "read", { mustExist: true })
      const file = await stableFile(resolved, context.policy.limits.maxReadBytes)
      const maximum = Math.min(
        parsed.limitBytes ?? context.policy.limits.maxReadBytes,
        context.policy.limits.maxReadBytes,
      )
      const selected = file.bytes.subarray(
        Math.min(parsed.offsetBytes, file.bytes.byteLength),
        Math.min(file.bytes.byteLength, parsed.offsetBytes + maximum),
      )
      const content =
        parsed.encoding === "base64"
          ? Buffer.from(selected).toString("base64")
          : utf8(selected, parsed.path)
      return {
        content: {
          path: resolved.portablePath,
          encoding: parsed.encoding,
          content,
          sha256: file.sha256,
          sizeBytes: file.bytes.byteLength,
          offsetBytes: parsed.offsetBytes,
          returnedBytes: selected.byteLength,
          truncated: parsed.offsetBytes + selected.byteLength < file.bytes.byteLength,
        },
        effects: [{ path: resolved.portablePath, kind: "read", afterSha256: file.sha256 }],
        recovery: "safe-to-retry",
      }
    },
  }

  const list: RegisteredTool = {
    definition: makeDefinition(
      "fs.list",
      "List bounded workspace entries without following symlink directories.",
      FsListInputSchema,
      "read",
      false,
    ),
    inputSchema: FsListInputSchema,
    assess(input, context) {
      const parsed = FsListInputSchema.parse(input)
      return readAssessment(parsed.path, context)
    },
    async execute(input, context) {
      const parsed = FsListInputSchema.parse(input)
      const entries = await listEntries(parsed, context)
      return {
        content: {
          path: parsed.path,
          entries,
          truncated:
            entries.length >=
            Math.min(
              parsed.limit ?? context.policy.limits.maxListEntries,
              context.policy.limits.maxListEntries,
            ),
        },
        recovery: "safe-to-retry",
      }
    },
  }

  const glob: RegisteredTool = {
    definition: makeDefinition(
      "fs.glob",
      "Find bounded workspace paths using a portable glob without following symlinks.",
      FsGlobInputSchema,
      "read",
      false,
    ),
    inputSchema: FsGlobInputSchema,
    assess(input, context) {
      const parsed = FsGlobInputSchema.parse(input)
      assertPattern(parsed.pattern)
      return readAssessment(parsed.path, context)
    },
    async execute(input, context) {
      const parsed = FsGlobInputSchema.parse(input)
      assertPattern(parsed.pattern)
      const root = await context.resolver.resolve(parsed.path, "read", {
        mustExist: true,
        allowRoot: true,
      })
      if (root.kind !== "directory") {
        throw new ToolHostError(
          "RALPH_TOOL_DIRECTORY_REQUIRED",
          `Directory required: ${parsed.path}`,
        )
      }
      const maximum = Math.min(
        parsed.limit ?? context.policy.limits.maxGlobMatches,
        context.policy.limits.maxGlobMatches,
      )
      const matches: string[] = []
      const scanner = new Bun.Glob(parsed.pattern)
      for await (const match of scanner.scan({
        cwd: root.canonicalPath ?? root.absolutePath,
        dot: true,
        absolute: false,
        followSymlinks: false,
        onlyFiles: false,
      })) {
        throwIfCancelled(context)
        const joined = parsed.path === "." ? match : `${parsed.path}/${match}`
        try {
          const resolved = await context.resolver.resolve(joined, "read", {
            mustExist: true,
            allowRoot: true,
          })
          matches.push(resolved.portablePath)
        } catch (error) {
          if (!(error instanceof ToolHostError)) throw error
        }
        if (matches.length >= maximum) break
      }
      matches.sort()
      return {
        content: {
          path: parsed.path,
          pattern: parsed.pattern,
          matches,
          truncated: matches.length >= maximum,
        },
        recovery: "safe-to-retry",
      }
    },
  }

  const search: RegisteredTool = {
    definition: makeDefinition(
      "fs.search",
      "Search for a bounded literal string in bounded UTF-8 workspace files.",
      FsSearchInputSchema,
      "read",
      false,
    ),
    inputSchema: FsSearchInputSchema,
    assess(input, context) {
      const parsed = FsSearchInputSchema.parse(input)
      assertPattern(parsed.filePattern)
      return readAssessment(parsed.path, context)
    },
    async execute(input, context) {
      const parsed = FsSearchInputSchema.parse(input)
      assertPattern(parsed.filePattern)
      const maximumMatches = Math.min(
        parsed.maxMatches ?? context.policy.limits.maxSearchMatches,
        context.policy.limits.maxSearchMatches,
      )
      const root = await context.resolver.resolve(parsed.path, "read", {
        mustExist: true,
        allowRoot: true,
      })
      if (root.kind !== "directory") {
        throw new ToolHostError(
          "RALPH_TOOL_DIRECTORY_REQUIRED",
          `Directory required: ${parsed.path}`,
        )
      }
      const scanner = new Bun.Glob(parsed.filePattern)
      const matches: Array<{ path: string; line: number; column: number; text: string }> = []
      let files = 0
      const needle = parsed.caseSensitive ? parsed.query : parsed.query.toLocaleLowerCase("und")
      for await (const match of scanner.scan({
        cwd: root.canonicalPath ?? root.absolutePath,
        dot: true,
        absolute: false,
        followSymlinks: false,
        onlyFiles: true,
      })) {
        throwIfCancelled(context)
        if (files >= context.policy.limits.maxSearchFiles || matches.length >= maximumMatches) break
        const joined = parsed.path === "." ? match : `${parsed.path}/${match}`
        let resolved: ResolvedWorkspacePath
        try {
          resolved = await context.resolver.resolve(joined, "read", { mustExist: true })
        } catch (error) {
          if (error instanceof ToolHostError) continue
          throw error
        }
        if (resolved.kind !== "file") continue
        const metadata = await lstat(resolved.absolutePath)
        if (metadata.size > context.policy.limits.maxSearchFileBytes) continue
        const file = await stableFile(resolved, context.policy.limits.maxSearchFileBytes)
        let text: string
        try {
          text = utf8(file.bytes, resolved.portablePath)
        } catch {
          continue
        }
        files += 1
        for (const [lineIndex, line] of text.split(/\r?\n/).entries()) {
          const candidate = parsed.caseSensitive ? line : line.toLocaleLowerCase("und")
          let offset = 0
          while (matches.length < maximumMatches) {
            const found = candidate.indexOf(needle, offset)
            if (found < 0) break
            matches.push({
              path: resolved.portablePath,
              line: lineIndex + 1,
              column: found + 1,
              text: line.slice(0, 1_000),
            })
            offset = found + Math.max(needle.length, 1)
          }
          if (matches.length >= maximumMatches) break
        }
      }
      return {
        content: {
          query: parsed.query,
          matches,
          filesScanned: files,
          truncated:
            matches.length >= maximumMatches || files >= context.policy.limits.maxSearchFiles,
        },
        recovery: "safe-to-retry",
      }
    },
  }

  const write: RegisteredTool = {
    definition: makeDefinition(
      "fs.write",
      "Create or replace one workspace file under an explicit absence or SHA-256 precondition.",
      FsWriteInputSchema,
      "write",
      true,
    ),
    inputSchema: FsWriteInputSchema,
    assess(input, context) {
      const parsed = FsWriteInputSchema.parse(input)
      return writeAssessment([parsed.path], context)
    },
    async execute(input, context) {
      const parsed = FsWriteInputSchema.parse(input)
      const bytes = Buffer.from(parsed.content, "utf8")
      if (bytes.byteLength > context.policy.limits.maxWriteBytes) {
        throw new ToolHostError(
          "RALPH_TOOL_WRITE_TOO_LARGE",
          `Write exceeds ${context.policy.limits.maxWriteBytes} bytes`,
          "invalid",
          "safe-to-retry",
        )
      }
      throwIfCancelled(context)
      let resolved = await context.resolver.resolve(parsed.path, "write")
      await ensureParent(context.resolver, resolved, parsed.createParents)
      resolved = await context.resolver.resolve(parsed.path, "write")
      let beforeSha256: string | null = null
      if (resolved.exists) {
        const before = await stableFile(resolved, context.policy.limits.maxWriteBytes)
        beforeSha256 = before.sha256
      }
      if (parsed.precondition.kind === "absent" && resolved.exists) {
        throw new ToolHostError(
          "RALPH_TOOL_PRECONDITION_EXISTS",
          `Expected file to be absent: ${parsed.path}`,
          "error",
          "reconcile-by-precondition",
          true,
        )
      }
      if (parsed.precondition.kind === "sha256" && beforeSha256 !== parsed.precondition.value) {
        throw new ToolHostError(
          "RALPH_TOOL_PRECONDITION_HASH",
          `Before hash does not match: ${parsed.path}`,
          "error",
          "reconcile-by-precondition",
          true,
        )
      }
      const afterSha256 = await atomicWrite(context.resolver, resolved, bytes)
      const effect: ToolEffect = {
        path: parsed.path,
        kind: beforeSha256 ? "modified" : "created",
        beforeSha256,
        afterSha256,
      }
      return {
        content: { path: parsed.path, beforeSha256, afterSha256, sizeBytes: bytes.byteLength },
        effects: [effect],
        recovery: "reconcile-by-precondition",
      }
    },
  }

  const edit: RegisteredTool = {
    definition: makeDefinition(
      "fs.edit",
      "Apply bounded deterministic text replacements to one file with a before hash.",
      FsEditInputSchema,
      "write",
      true,
    ),
    inputSchema: FsEditInputSchema,
    assess(input, context) {
      const parsed = FsEditInputSchema.parse(input)
      return writeAssessment([parsed.path], context)
    },
    async execute(input, context) {
      const parsed = FsEditInputSchema.parse(input)
      const resolved = await context.resolver.resolve(parsed.path, "write", { mustExist: true })
      const before = await stableFile(resolved, context.policy.limits.maxWriteBytes)
      if (before.sha256 !== parsed.beforeSha256) {
        throw new ToolHostError(
          "RALPH_TOOL_PRECONDITION_HASH",
          `Before hash does not match: ${parsed.path}`,
          "error",
          "reconcile-by-precondition",
          true,
        )
      }
      const content = replacementResult(
        utf8(before.bytes, parsed.path),
        parsed.replacements,
        parsed.path,
      )
      const bytes = Buffer.from(content, "utf8")
      if (bytes.byteLength > context.policy.limits.maxWriteBytes) {
        throw new ToolHostError(
          "RALPH_TOOL_WRITE_TOO_LARGE",
          "Edited file exceeds write limit",
          "invalid",
        )
      }
      const afterSha256 = await atomicWrite(context.resolver, resolved, bytes)
      return {
        content: {
          path: parsed.path,
          beforeSha256: before.sha256,
          afterSha256,
          sizeBytes: bytes.byteLength,
        },
        effects: [
          {
            path: parsed.path,
            kind: "modified",
            beforeSha256: before.sha256,
            afterSha256,
          },
        ],
        recovery: "reconcile-by-precondition",
      }
    },
  }

  const applyPatch: RegisteredTool = {
    definition: makeDefinition(
      "fs.apply_patch",
      "Apply a Ralph structured replacement patch with a before hash for every file.",
      FsApplyPatchInputSchema,
      "write",
      true,
    ),
    inputSchema: FsApplyPatchInputSchema,
    assess(input, context) {
      const parsed = FsApplyPatchInputSchema.parse(input)
      return writeAssessment(
        parsed.changes.map((change) => change.path),
        context,
      )
    },
    async execute(input, context) {
      const parsed = FsApplyPatchInputSchema.parse(input)
      const plans: Array<{
        path: string
        resolved: ResolvedWorkspacePath
        beforeSha256: string
        bytes: Uint8Array
        afterSha256: string
      }> = []
      for (const change of parsed.changes) {
        throwIfCancelled(context)
        const resolved = await context.resolver.resolve(change.path, "write", { mustExist: true })
        const before = await stableFile(resolved, context.policy.limits.maxWriteBytes)
        if (before.sha256 !== change.beforeSha256) {
          throw new ToolHostError(
            "RALPH_TOOL_PRECONDITION_HASH",
            `Before hash does not match: ${change.path}`,
            "error",
            "reconcile-by-precondition",
            true,
          )
        }
        const content = replacementResult(
          utf8(before.bytes, change.path),
          change.replacements,
          change.path,
        )
        const bytes = Buffer.from(content, "utf8")
        if (bytes.byteLength > context.policy.limits.maxWriteBytes) {
          throw new ToolHostError(
            "RALPH_TOOL_WRITE_TOO_LARGE",
            `Patched file exceeds write limit: ${change.path}`,
            "invalid",
          )
        }
        plans.push({
          path: change.path,
          resolved,
          beforeSha256: before.sha256,
          bytes,
          afterSha256: sha256(bytes),
        })
      }
      const effects: ToolEffect[] = []
      for (const plan of plans) {
        throwIfCancelled(context)
        let actual: string
        try {
          actual = await atomicWrite(context.resolver, plan.resolved, plan.bytes)
        } catch (error) {
          throw new ToolHostError(
            "RALPH_TOOL_PATCH_PARTIAL",
            `Structured patch stopped while applying ${plan.path}`,
            error instanceof ToolHostError ? error.outcome : "error",
            "reconcile-by-precondition",
            true,
            {
              cause: error,
              effects,
              content: {
                completed: effects,
                interruptedPath: plan.path,
                expectedBeforeSha256: plan.beforeSha256,
                expectedAfterSha256: plan.afterSha256,
              },
            },
          )
        }
        if (actual !== plan.afterSha256) {
          throw new ToolHostError(
            "RALPH_TOOL_PATCH_AFTER_HASH",
            `Patched file hash is inconsistent: ${plan.path}`,
            "error",
            "manual-review",
          )
        }
        effects.push({
          path: plan.path,
          kind: "modified",
          beforeSha256: plan.beforeSha256,
          afterSha256: plan.afterSha256,
        })
      }
      return {
        content: {
          description: parsed.description,
          files: effects.map((effect) => ({
            path: effect.path,
            beforeSha256: effect.beforeSha256,
            afterSha256: effect.afterSha256,
          })),
        },
        effects,
        recovery: "reconcile-by-precondition",
      }
    },
  }

  return [read, list, glob, search, write, edit, applyPatch]
}
