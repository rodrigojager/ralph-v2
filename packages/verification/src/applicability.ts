import type { VerificationSpec } from "@ralph-next/prd"
import { pathWithinPortableScope, portablePath, resolveSafeWorkspaceTarget } from "./path-safety"

export type ApplicabilityResult =
  | { status: "applicable" }
  | { status: "not_applicable"; reason: string }
  | { status: "error"; reason: string }

export async function evaluateVerificationApplicability(
  specification: VerificationSpec,
  options: {
    workspaceRoot: string
    platform?: NodeJS.Platform
    changedPaths?: ReadonlySet<string>
  },
): Promise<ApplicabilityResult> {
  const applicability =
    specification.type === "instruction" ? undefined : specification.applicability
  if (!applicability) return { status: "applicable" }
  const platform = options.platform ?? process.platform
  if (applicability.platforms && !applicability.platforms.includes(platform as never)) {
    return {
      status: "not_applicable",
      reason: `Gate is not applicable on platform ${platform}; expected ${applicability.platforms.join(", ")}`,
    }
  }
  try {
    for (const condition of applicability.conditions ?? []) {
      if (condition.kind === "path-changed") {
        if (!options.changedPaths) {
          return {
            status: "error",
            reason: `Applicability condition path-changed requires changedPaths: ${condition.path}`,
          }
        }
        const expected = portablePath(condition.path)
        const matched = [...options.changedPaths].some((path) =>
          condition.match === "prefix"
            ? pathWithinPortableScope(path, expected)
            : portablePath(path) === expected,
        )
        if (!matched) {
          return {
            status: "not_applicable",
            reason: `No changed path matched ${condition.match ?? "exact"}:${condition.path}`,
          }
        }
        continue
      }
      const target = await resolveSafeWorkspaceTarget(options.workspaceRoot, condition.path)
      const matched = condition.kind === "file-exists" ? target.exists : !target.exists
      if (!matched) {
        return {
          status: "not_applicable",
          reason:
            condition.kind === "file-exists"
              ? `Applicability file does not exist: ${condition.path}`
              : `Applicability file must be absent: ${condition.path}`,
        }
      }
    }
    return { status: "applicable" }
  } catch (error) {
    return { status: "error", reason: error instanceof Error ? error.message : String(error) }
  }
}
