import { EXIT_CODES, RalphError } from "@ralph/domain"
import {
  type ReleaseArtifact,
  type ReleaseManifest,
  ReleaseManifestSchema,
  type ReleaseTarget,
  ReleaseTargetSchema,
  type ReleaseTargetSupportPolicy,
} from "./contracts"

export function releaseTargetFor(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): ReleaseTarget {
  if (architecture !== "x64" && architecture !== "arm64") {
    throw new RalphError(
      "RALPH_RELEASE_ARCHITECTURE_UNSUPPORTED",
      `Unsupported native architecture: ${architecture}`,
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  if (platform === "win32") {
    return architecture === "arm64" ? "bun-windows-arm64" : "bun-windows-x64-baseline"
  }
  if (platform === "linux") {
    return architecture === "arm64" ? "bun-linux-arm64" : "bun-linux-x64-baseline"
  }
  if (platform === "darwin") {
    return architecture === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64"
  }
  throw new RalphError(
    "RALPH_RELEASE_PLATFORM_UNSUPPORTED",
    `Unsupported native platform: ${platform}`,
    { exitCode: EXIT_CODES.invalidUsage },
  )
}

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  return ReleaseManifestSchema.parse(value)
}

export function selectReleaseTargetSupport(
  manifest: ReleaseManifest,
  target: ReleaseTarget = releaseTargetFor(),
): Extract<ReleaseTargetSupportPolicy, { status: "included" }> {
  ReleaseTargetSchema.parse(target)
  const support = manifest.supportPolicy.matrix.find((entry) => entry.target === target)
  if (!support) {
    throw new RalphError(
      "RALPH_RELEASE_SUPPORT_MATRIX_INCOMPLETE",
      `Release ${manifest.version} omits ${target} from its explicit support matrix`,
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  if (support.status !== "included") {
    throw new RalphError(
      "RALPH_RELEASE_TARGET_NOT_PROMOTED",
      `Release ${manifest.version} explicitly does not include or promote ${target}: ${support.reason}`,
      {
        exitCode: EXIT_CODES.blocked,
        hint: "Select a release whose versioned support policy explicitly includes this target; inclusion alone is not tested support.",
        details: {
          target,
          status: support.status,
          reason: support.reason,
          capabilities: support.capabilities,
          supportPolicySha256: manifest.supportPolicySha256,
        },
      },
    )
  }
  return support
}

export function selectReleaseArtifact(
  manifest: ReleaseManifest,
  target: ReleaseTarget = releaseTargetFor(),
): ReleaseArtifact {
  ReleaseTargetSchema.parse(target)
  selectReleaseTargetSupport(manifest, target)
  const artifact = manifest.artifacts.find((candidate) => candidate.target === target)
  if (!artifact) {
    throw new RalphError(
      "RALPH_RELEASE_TARGET_NOT_EVIDENCED",
      `Release ${manifest.version} has no usable artifact evidence for ${target}`,
      {
        exitCode: EXIT_CODES.invalidUsage,
        hint: "Select a release/target whose manifest is at least built-not-tested.",
      },
    )
  }
  if (artifact.evidenceStatus === "not-evidenced") {
    throw new RalphError(
      "RALPH_RELEASE_TARGET_NOT_EVIDENCED",
      `Release ${manifest.version} has no usable artifact evidence for ${target}`,
      {
        exitCode: EXIT_CODES.invalidUsage,
        hint: "Select a release/target whose manifest is at least built-not-tested.",
      },
    )
  }
  if (manifest.channel === "stable" && artifact.evidenceStatus !== "tested") {
    throw new RalphError(
      "RALPH_RELEASE_STABLE_TARGET_NOT_TESTED",
      `Stable release ${manifest.version} is not evidenced as tested for ${target}`,
      {
        exitCode: EXIT_CODES.invalidUsage,
        hint: "Use a stable manifest whose selected target is bound to tested promotion evidence.",
      },
    )
  }
  return artifact
}
