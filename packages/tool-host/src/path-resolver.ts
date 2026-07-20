import type { Stats } from "node:fs"
import { lstat, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import type { ToolPolicy } from "./contracts"
import { ToolHostError } from "./errors"

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const CONTROL_PATHS = [".ralph", ".git"] as const

export type WorkspacePathOperation = "read" | "write"
export type WorkspaceEntryKind = "file" | "directory" | "symlink" | "other" | "missing"

type PathProbe = {
  path: string
  canonicalPath: string
  fingerprint: string
  stableDirectoryFingerprint: string
  symlink: boolean
}

type PermittedDirectoryMetadataMutation = {
  path: string
  canonicalPath: string
  stableFingerprint: string
}

export type ResolvedWorkspacePath = {
  portablePath: string
  absolutePath: string
  canonicalPath?: string
  kind: WorkspaceEntryKind
  exists: boolean
  operation: WorkspacePathOperation
  protected: boolean
  inScope: boolean
  probes: readonly PathProbe[]
}

function portable(value: string): string {
  return value.replaceAll("\\", "/")
}

function comparable(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("und") : value
}

function contained(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function fingerprint(metadata: Stats): string {
  return [
    metadata.dev,
    metadata.ino,
    metadata.mode,
    metadata.size,
    metadata.mtimeMs,
    metadata.ctimeMs,
  ].join(":")
}

function stableDirectoryFingerprint(metadata: Stats): string {
  // dev+ino+type preserve identity while mode/owner preserve the security
  // boundary. nlink and birthtime are intentionally excluded: APFS can expose
  // them as mutable directory-entry metadata while this writer stages its own
  // temporary file, which is not an identity or containment change.
  return [
    metadata.dev,
    metadata.ino,
    metadata.mode,
    metadata.uid,
    metadata.gid,
    metadata.rdev,
    metadata.isDirectory(),
    metadata.isSymbolicLink(),
  ].join(":")
}

function entryKind(metadata: Stats): WorkspaceEntryKind {
  if (metadata.isSymbolicLink()) return "symlink"
  if (metadata.isFile()) return "file"
  if (metadata.isDirectory()) return "directory"
  return "other"
}

function normalizePortablePath(value: string, allowRoot: boolean): string {
  if (value !== value.trim()) {
    throw new ToolHostError(
      "RALPH_TOOL_PATH_WHITESPACE",
      "Workspace paths cannot have outer whitespace",
    )
  }
  if (
    !value ||
    [...value].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 0x1f || code === 0x7f
    })
  ) {
    throw new ToolHostError(
      "RALPH_TOOL_PATH_INVALID",
      "Workspace path is empty or contains control characters",
    )
  }
  if (value.includes("\\")) {
    throw new ToolHostError(
      "RALPH_TOOL_PATH_NOT_PORTABLE",
      "Workspace paths must use portable forward slashes",
    )
  }
  if (
    isAbsolute(value) ||
    value.startsWith("/") ||
    value.startsWith("//") ||
    /^[A-Za-z]:/.test(value) ||
    /^\\\\[?.]\\/.test(value)
  ) {
    throw new ToolHostError(
      "RALPH_TOOL_PATH_ABSOLUTE",
      "Absolute, UNC, and device paths are forbidden",
    )
  }
  const stripped = value.startsWith("./") ? value.slice(2) : value
  if (stripped === "." || stripped === "") {
    if (allowRoot) return "."
    throw new ToolHostError("RALPH_TOOL_PATH_ROOT", "This operation requires a file path")
  }
  const segments = stripped.split("/")
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      throw new ToolHostError(
        "RALPH_TOOL_PATH_TRAVERSAL",
        "Workspace paths cannot contain empty, dot, or parent segments",
      )
    }
    if (segment.includes(":")) {
      throw new ToolHostError(
        "RALPH_TOOL_PATH_ALTERNATE_STREAM",
        "Colon and alternate data stream syntax are forbidden",
      )
    }
    if (segment.endsWith(".") || segment.endsWith(" ")) {
      throw new ToolHostError(
        "RALPH_TOOL_PATH_WINDOWS_AMBIGUOUS",
        "Trailing dots and spaces are forbidden in portable workspace paths",
      )
    }
    if (WINDOWS_RESERVED_NAME.test(segment)) {
      throw new ToolHostError(
        "RALPH_TOOL_PATH_WINDOWS_DEVICE",
        `Reserved Windows device path is forbidden: ${segment}`,
      )
    }
  }
  return segments.join("/")
}

function inScopes(path: string, scopes: readonly string[]): boolean {
  const candidate = comparable(path)
  return scopes.some((scopeValue) => {
    const scope = comparable(scopeValue)
    return scope === "." || candidate === scope || candidate.startsWith(`${scope}/`)
  })
}

function isProtected(path: string, protectedPaths: readonly string[]): boolean {
  const candidate = comparable(path)
  return protectedPaths.some((protectedValue) => {
    const boundary = comparable(protectedValue)
    return candidate === boundary || candidate.startsWith(`${boundary}/`)
  })
}

async function metadataOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

export class WorkspacePathResolver {
  readonly root: string
  readonly #rootCanonicalPath: string
  readonly #rootStableDirectoryFingerprint: string
  readonly #readScopes: readonly string[]
  readonly #writeScopes: readonly string[]
  readonly #protectedPaths: readonly string[]
  readonly #followInternalSymlinksForRead: boolean

  private constructor(root: string, rootMetadata: Stats, policy: ToolPolicy) {
    this.root = root
    this.#rootCanonicalPath = root
    this.#rootStableDirectoryFingerprint = stableDirectoryFingerprint(rootMetadata)
    this.#readScopes = policy.readScopes.map((value) => normalizePortablePath(value, true))
    this.#writeScopes = policy.writeScopes.map((value) => normalizePortablePath(value, true))
    this.#protectedPaths = [...CONTROL_PATHS, ...policy.protectedPaths].map((value) =>
      normalizePortablePath(value, true),
    )
    this.#followInternalSymlinksForRead = policy.followInternalSymlinksForRead
  }

  static async create(workspaceRoot: string, policy: ToolPolicy): Promise<WorkspacePathResolver> {
    const root = await realpath(resolve(workspaceRoot))
    const metadata = await lstat(root)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new ToolHostError(
        "RALPH_TOOL_WORKSPACE_INVALID",
        "Canonical workspace root must be a regular directory",
      )
    }
    return new WorkspacePathResolver(root, metadata, policy)
  }

  normalize(value: string, allowRoot = false): string {
    return normalizePortablePath(value, allowRoot)
  }

  isProtected(value: string): boolean {
    return isProtected(normalizePortablePath(value, true), this.#protectedPaths)
  }

  isInScope(value: string, operation: WorkspacePathOperation): boolean {
    const path = normalizePortablePath(value, true)
    return inScopes(path, operation === "read" ? this.#readScopes : this.#writeScopes)
  }

  async resolve(
    value: string,
    operation: WorkspacePathOperation,
    options: { mustExist?: boolean; allowRoot?: boolean } = {},
  ): Promise<ResolvedWorkspacePath> {
    const path = normalizePortablePath(value, options.allowRoot ?? false)
    const protectedPath = isProtected(path, this.#protectedPaths)
    if (protectedPath) {
      throw new ToolHostError(
        "RALPH_TOOL_PATH_PROTECTED",
        `Control-plane or protected path is unavailable to tools: ${path}`,
        "denied",
        "manual-review",
      )
    }
    const scopes = operation === "read" ? this.#readScopes : this.#writeScopes
    const scoped = inScopes(path, scopes)
    if (!scoped) {
      throw new ToolHostError(
        "RALPH_TOOL_PATH_OUT_OF_SCOPE",
        `Path is outside the ${operation} scopes: ${path}`,
        "denied",
        "manual-review",
      )
    }
    const absolute = path === "." ? this.root : resolve(this.root, ...path.split("/"))
    if (!contained(this.root, absolute)) {
      throw new ToolHostError("RALPH_TOOL_PATH_ESCAPE", `Path escapes workspace: ${path}`, "denied")
    }

    const probes: PathProbe[] = []
    const segments = path === "." ? [] : path.split("/")
    let cursor = this.root
    let finalMetadata = await lstat(this.root)
    let canonicalPath: string | undefined = this.root
    let missing = false
    for (const [index, segment] of segments.entries()) {
      cursor = resolve(cursor, segment)
      const metadata = await metadataOrUndefined(cursor)
      if (!metadata) {
        missing = true
        canonicalPath = undefined
        break
      }
      const linked = metadata.isSymbolicLink()
      if (linked && (operation === "write" || !this.#followInternalSymlinksForRead)) {
        throw new ToolHostError(
          "RALPH_TOOL_PATH_LINKED",
          `Symlink or junction is forbidden for this operation: ${path}`,
          "denied",
        )
      }
      const canonical = await realpath(cursor)
      if (!contained(this.root, canonical)) {
        throw new ToolHostError(
          "RALPH_TOOL_PATH_LINK_ESCAPE",
          `Path resolves outside the workspace: ${path}`,
          "denied",
        )
      }
      probes.push({
        path: cursor,
        canonicalPath: canonical,
        fingerprint: fingerprint(metadata),
        stableDirectoryFingerprint: stableDirectoryFingerprint(metadata),
        symlink: linked,
      })
      if (index < segments.length - 1 && !metadata.isDirectory() && !linked) {
        throw new ToolHostError(
          "RALPH_TOOL_PATH_ANCESTOR_NOT_DIRECTORY",
          `Path ancestor is not a directory: ${portable(relative(this.root, cursor))}`,
        )
      }
      finalMetadata = metadata
      canonicalPath = canonical
    }

    if (missing && options.mustExist) {
      throw new ToolHostError("RALPH_TOOL_PATH_MISSING", `Workspace path does not exist: ${path}`)
    }
    return {
      portablePath: path,
      absolutePath: absolute,
      ...(canonicalPath ? { canonicalPath } : {}),
      kind: missing ? "missing" : entryKind(finalMetadata),
      exists: !missing,
      operation,
      protected: protectedPath,
      inScope: scoped,
      probes,
    }
  }

  async revalidate(path: ResolvedWorkspacePath): Promise<void> {
    await this.#revalidate(path)
  }

  async guardParentDirectoryMetadataMutation(
    path: ResolvedWorkspacePath,
  ): Promise<() => Promise<void>> {
    if (path.operation !== "write") {
      throw new ToolHostError(
        "RALPH_TOOL_PATH_OPERATION",
        "A parent directory mutation guard requires a write-authorized path",
        "denied",
      )
    }
    await this.#revalidate(path)
    const parentPath = dirname(path.absolutePath)
    if (!contained(this.root, parentPath)) {
      throw new ToolHostError(
        "RALPH_TOOL_PATH_ESCAPE",
        `Write parent escapes workspace: ${path.portablePath}`,
        "denied",
      )
    }

    const parentProbe = path.probes.find(
      (probe) => comparable(probe.path) === comparable(parentPath),
    )
    const expectedCanonicalPath = parentProbe?.canonicalPath ?? this.#rootCanonicalPath
    const expectedStableFingerprint =
      parentProbe?.stableDirectoryFingerprint ?? this.#rootStableDirectoryFingerprint
    const metadata = await metadataOrUndefined(parentPath)
    if (
      !metadata ||
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      stableDirectoryFingerprint(metadata) !== expectedStableFingerprint ||
      (parentProbe && fingerprint(metadata) !== parentProbe.fingerprint)
    ) {
      throw new ToolHostError(
        "RALPH_TOOL_PATH_CHANGED",
        `Workspace write parent changed after authorization: ${path.portablePath}`,
        "error",
        "reconcile-by-precondition",
        true,
      )
    }
    const canonicalPath = await realpath(parentPath)
    if (!contained(this.root, canonicalPath)) {
      throw new ToolHostError(
        "RALPH_TOOL_PATH_CHANGED_ESCAPE",
        `Workspace write parent escaped after authorization: ${path.portablePath}`,
        "denied",
        "manual-review",
      )
    }
    if (comparable(canonicalPath) !== comparable(expectedCanonicalPath)) {
      throw new ToolHostError(
        "RALPH_TOOL_PATH_CHANGED",
        `Workspace write parent identity changed after authorization: ${path.portablePath}`,
        "error",
        "reconcile-by-precondition",
        true,
      )
    }

    const permittedMutation: PermittedDirectoryMetadataMutation = {
      path: parentPath,
      canonicalPath,
      stableFingerprint: expectedStableFingerprint,
    }
    return async () => this.#revalidate(path, permittedMutation)
  }

  async #revalidate(
    path: ResolvedWorkspacePath,
    permittedMutation?: PermittedDirectoryMetadataMutation,
  ): Promise<void> {
    for (const probe of path.probes) {
      const metadata = await metadataOrUndefined(probe.path)
      const permitsDirectoryMetadataChange =
        permittedMutation && comparable(probe.path) === comparable(permittedMutation.path)
      if (
        !metadata ||
        metadata.isSymbolicLink() !== probe.symlink ||
        (permitsDirectoryMetadataChange
          ? metadata.isSymbolicLink() ||
            !metadata.isDirectory() ||
            stableDirectoryFingerprint(metadata) !== permittedMutation.stableFingerprint
          : fingerprint(metadata) !== probe.fingerprint)
      ) {
        throw new ToolHostError(
          "RALPH_TOOL_PATH_CHANGED",
          `Workspace path changed after authorization: ${path.portablePath}`,
          "error",
          "reconcile-by-precondition",
          true,
        )
      }
      const canonical = await realpath(probe.path)
      if (!contained(this.root, canonical)) {
        throw new ToolHostError(
          "RALPH_TOOL_PATH_CHANGED_ESCAPE",
          `Workspace path escaped after authorization: ${path.portablePath}`,
          "denied",
          "manual-review",
        )
      }
      const expectedCanonical = permitsDirectoryMetadataChange
        ? permittedMutation.canonicalPath
        : probe.canonicalPath
      if (comparable(canonical) !== comparable(expectedCanonical)) {
        throw new ToolHostError(
          "RALPH_TOOL_PATH_CHANGED",
          `Workspace path identity changed after authorization: ${path.portablePath}`,
          "error",
          "reconcile-by-precondition",
          true,
        )
      }
    }
    if (permittedMutation) {
      const metadata = await metadataOrUndefined(permittedMutation.path)
      if (
        !metadata ||
        metadata.isSymbolicLink() ||
        !metadata.isDirectory() ||
        stableDirectoryFingerprint(metadata) !== permittedMutation.stableFingerprint
      ) {
        throw new ToolHostError(
          "RALPH_TOOL_PATH_CHANGED",
          `Workspace write parent changed during staging: ${path.portablePath}`,
          "error",
          "reconcile-by-precondition",
          true,
        )
      }
      const canonical = await realpath(permittedMutation.path)
      if (!contained(this.root, canonical)) {
        throw new ToolHostError(
          "RALPH_TOOL_PATH_CHANGED_ESCAPE",
          `Workspace write parent escaped during staging: ${path.portablePath}`,
          "denied",
          "manual-review",
        )
      }
      if (comparable(canonical) !== comparable(permittedMutation.canonicalPath)) {
        throw new ToolHostError(
          "RALPH_TOOL_PATH_CHANGED",
          `Workspace write parent identity changed during staging: ${path.portablePath}`,
          "error",
          "reconcile-by-precondition",
          true,
        )
      }
    }
    if (!path.exists) {
      const metadata = await metadataOrUndefined(path.absolutePath)
      if (metadata) {
        throw new ToolHostError(
          "RALPH_TOOL_PRECONDITION_EXISTS",
          `Expected path to remain absent: ${path.portablePath}`,
          "error",
          "reconcile-by-precondition",
          true,
        )
      }
    }
  }
}
