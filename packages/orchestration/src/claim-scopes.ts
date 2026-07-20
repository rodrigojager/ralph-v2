import { lstat, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import {
  EXIT_CODES,
  RalphError,
  type ResourceClaimMode,
  type ResourceClaimSpec,
} from "@ralph-next/domain"

export type CanonicalPathClaimBinding = {
  workspaceRoot: string
  requestedPath: string
  canonicalPath: string
  stableAncestor: string
  stableAncestorDevice: number
  stableAncestorInode: number
  recursive: boolean
  boundAt: string
}

function comparable(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("und") : value
}

function contained(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function portable(value: string): string {
  return value.replaceAll("\\", "/")
}

async function stableExistingAncestor(target: string): Promise<{
  ancestor: string
  missingSegments: readonly string[]
}> {
  let cursor = target
  const missingSegments: string[] = []
  while (true) {
    try {
      await lstat(cursor)
      return { ancestor: cursor, missingSegments: missingSegments.reverse() }
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error
      }
      const parent = dirname(cursor)
      if (parent === cursor) {
        throw new RalphError(
          "RALPH_CLAIM_PATH_UNRESOLVABLE",
          "No existing ancestor can anchor the requested path claim",
          { exitCode: EXIT_CODES.invalidUsage, file: target },
        )
      }
      missingSegments.push(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
      cursor = parent
    }
  }
}

function normalizeRequestedPath(value: string): { path: string; recursive: boolean } {
  const normalized = value.trim().replaceAll("\\", "/")
  const recursive = normalized.endsWith("/**")
  const path = recursive ? normalized.slice(0, -3).replace(/\/+$/, "") : normalized
  if (!path || path.includes("\0") || /(^|\/)\.\.(\/|$)/.test(path)) {
    throw new RalphError(
      "RALPH_CLAIM_PATH_INVALID",
      "Path claim must be non-empty and cannot contain parent traversal or NUL bytes",
      { exitCode: EXIT_CODES.invalidUsage, details: { requestedPath: value } },
    )
  }
  if (path.includes("*") || path.includes("?")) {
    throw new RalphError(
      "RALPH_CLAIM_PATH_WILDCARD_INVALID",
      "Only a terminal /** recursive claim wildcard is supported",
      { exitCode: EXIT_CODES.invalidUsage, details: { requestedPath: value } },
    )
  }
  return { path, recursive }
}

export async function bindCanonicalPathClaim(
  workspaceRoot: string,
  requestedPath: string,
  mode: ResourceClaimMode = "exclusive",
  now: () => Date = () => new Date(),
): Promise<{ spec: ResourceClaimSpec; binding: CanonicalPathClaimBinding }> {
  const workspace = await realpath(resolve(workspaceRoot))
  const requested = normalizeRequestedPath(requestedPath)
  const lexicalTarget = resolve(workspace, requested.path)
  if (!contained(workspace, lexicalTarget)) {
    throw new RalphError(
      "RALPH_CLAIM_PATH_ESCAPE",
      "Path claim resolves outside the canonical workspace",
      {
        exitCode: EXIT_CODES.permissionDenied,
        file: lexicalTarget,
        details: { workspaceRoot: workspace, requestedPath },
      },
    )
  }
  const anchor = await stableExistingAncestor(lexicalTarget)
  const stableAncestor = await realpath(anchor.ancestor)
  if (!contained(workspace, stableAncestor)) {
    throw new RalphError(
      "RALPH_CLAIM_PATH_ESCAPE",
      "Path claim traverses a symlink or junction outside the canonical workspace",
      {
        exitCode: EXIT_CODES.permissionDenied,
        file: stableAncestor,
        details: { workspaceRoot: workspace, requestedPath },
      },
    )
  }
  const canonicalPath = resolve(stableAncestor, ...anchor.missingSegments)
  if (!contained(workspace, canonicalPath)) {
    throw new RalphError(
      "RALPH_CLAIM_PATH_ESCAPE",
      "Canonical path claim escapes the workspace after ancestor resolution",
      { exitCode: EXIT_CODES.permissionDenied, file: canonicalPath },
    )
  }
  const anchorStat = await lstat(stableAncestor)
  const binding: CanonicalPathClaimBinding = {
    workspaceRoot: workspace,
    requestedPath,
    canonicalPath,
    stableAncestor,
    stableAncestorDevice: anchorStat.dev,
    stableAncestorInode: anchorStat.ino,
    recursive: requested.recursive,
    boundAt: now().toISOString(),
  }
  return {
    binding,
    spec: {
      kind: "path",
      resourceKey: `${portable(canonicalPath)}${requested.recursive ? "/**" : ""}`,
      mode,
      metadata: {
        canonical: true,
        requestedPath,
        stableAncestor: portable(stableAncestor),
        stableAncestorDevice: anchorStat.dev,
        stableAncestorInode: anchorStat.ino,
        recursive: requested.recursive,
        boundAt: binding.boundAt,
      },
    },
  }
}

export async function revalidateCanonicalPathClaim(
  binding: CanonicalPathClaimBinding,
): Promise<void> {
  const rebound = await bindCanonicalPathClaim(
    binding.workspaceRoot,
    binding.requestedPath,
    "exclusive",
  )
  const samePath = comparable(rebound.binding.canonicalPath) === comparable(binding.canonicalPath)
  const sameAncestor =
    comparable(rebound.binding.stableAncestor) === comparable(binding.stableAncestor) &&
    rebound.binding.stableAncestorDevice === binding.stableAncestorDevice &&
    rebound.binding.stableAncestorInode === binding.stableAncestorInode
  if (!samePath || !sameAncestor) {
    throw new RalphError(
      "RALPH_CLAIM_PATH_CHANGED",
      "Path claim changed through a symlink, junction, rename or ancestor replacement",
      {
        exitCode: EXIT_CODES.conflict,
        file: binding.requestedPath,
        details: {
          expectedCanonicalPath: binding.canonicalPath,
          observedCanonicalPath: rebound.binding.canonicalPath,
          expectedStableAncestor: binding.stableAncestor,
          observedStableAncestor: rebound.binding.stableAncestor,
        },
        hint: "Pause the attempt and acquire a fresh canonical claim after inspecting the workspace change.",
      },
    )
  }
}

export function taskResourceClaim(
  runId: string,
  documentId: string,
  taskId: string,
): ResourceClaimSpec {
  return {
    kind: "task",
    resourceKey: `${runId}:${documentId}:${taskId}`,
    mode: "exclusive",
    metadata: {},
  }
}

export function artifactResourceClaim(workspaceId: string, artifactId: string): ResourceClaimSpec {
  return {
    kind: "artifact",
    resourceKey: `${workspaceId}:${artifactId}`,
    mode: "exclusive",
    metadata: {},
  }
}

export function portResourceClaim(
  workspaceId: string,
  protocol: "tcp" | "udp",
  host: string,
  port: number,
): ResourceClaimSpec {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new RalphError("RALPH_CLAIM_PORT_INVALID", "Port claim must be between 1 and 65535", {
      exitCode: EXIT_CODES.invalidUsage,
      details: { port },
    })
  }
  const normalizedHost = host.trim().toLocaleLowerCase("und")
  if (!normalizedHost || /[\s\0]/.test(normalizedHost)) {
    throw new RalphError("RALPH_CLAIM_PORT_INVALID", "Port claim host is invalid", {
      exitCode: EXIT_CODES.invalidUsage,
      details: { host },
    })
  }
  return {
    kind: "port",
    resourceKey: `${workspaceId}:${protocol}:${normalizedHost}:${port}`,
    mode: "exclusive",
    metadata: { protocol, host: normalizedHost, port },
  }
}

export type ScopeExpansionPolicy = "deny" | "pause" | "accept-if-unclaimed"

export interface ScopeExpansionPort {
  expand(input: { claimSetId: string; addition: ResourceClaimSpec; reason: string }): Promise<void>
}

export async function handlePathScopeExpansion(input: {
  workspaceRoot: string
  touchedPath: string
  claimSetId: string
  policy: ScopeExpansionPolicy
  port: ScopeExpansionPort
}): Promise<{ status: "accepted" | "paused" | "denied"; binding?: CanonicalPathClaimBinding }> {
  if (input.policy === "deny") {
    return { status: "denied" }
  }
  if (input.policy === "pause") {
    return { status: "paused" }
  }
  const bound = await bindCanonicalPathClaim(input.workspaceRoot, input.touchedPath, "exclusive")
  await input.port.expand({
    claimSetId: input.claimSetId,
    addition: bound.spec,
    reason: `Worker touched undeclared canonical path ${bound.binding.canonicalPath}`,
  })
  return { status: "accepted", binding: bound.binding }
}
