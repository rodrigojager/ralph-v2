import { modelSatisfiesRequirements, validateModelCatalogSnapshotIntegrity } from "./catalog"
import {
  FallbackPolicySchema,
  ModelCatalogSnapshotSchema,
  type ModelInfo,
  type ModelRouteRequest,
  type ModelRouter,
  type ProviderInfo,
  type ResolvedModelRoute,
  ResolvedModelRouteSchema,
  type RoleProfile,
  RoleProfileSchema,
  type RoutingFailureClass,
  RoutingFailureClassSchema,
} from "./contracts"
import { ProviderCoreError } from "./errors"

const FALLBACK_ELIGIBLE_FAILURES = new Set<RoutingFailureClass>([
  "provider-unavailable",
  "model-unavailable",
  "rate-limit",
  "transient",
])

const PROFILE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

type RouteCandidate = {
  profile: RoleProfile
  provider: ProviderInfo
  model: ModelInfo
}

function uniqueProfileIds(values: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (!PROFILE_ID_PATTERN.test(value)) {
      throw new ProviderCoreError(
        "PROVIDER_ROUTE_PROFILE_ID_INVALID",
        `Invalid attempted role profile id: ${value}`,
        { profileId: value },
      )
    }
    if (!seen.has(value)) {
      seen.add(value)
      result.push(value)
    }
  }
  return result
}

export class CatalogModelRouter implements ModelRouter {
  resolve(request: ModelRouteRequest): ResolvedModelRoute {
    ModelCatalogSnapshotSchema.parse(request.snapshot)
    const snapshot = validateModelCatalogSnapshotIntegrity(request.snapshot)
    const policy = FallbackPolicySchema.parse(request.fallbackPolicy)
    const profiles = this.#parseProfiles(request.profiles)
    const requested = profiles.get(request.requestedProfileId)
    if (!requested) {
      throw new ProviderCoreError(
        "PROVIDER_ROUTE_PROFILE_UNKNOWN",
        `Requested role profile ${request.requestedProfileId} does not exist`,
        { profileId: request.requestedProfileId },
      )
    }

    const attempted = uniqueProfileIds(request.attemptedProfiles ?? [])
    if (request.failure === undefined) {
      if (attempted.includes(requested.id)) {
        throw new ProviderCoreError(
          "PROVIDER_ROUTE_PROFILE_ALREADY_ATTEMPTED",
          `Requested role profile ${requested.id} was already attempted`,
          { profileId: requested.id },
        )
      }
      const candidate = this.#candidate(requested, snapshot.providers, snapshot.models)
      return this.#route(requested, candidate, snapshot.id, [...attempted, requested.id], false)
    }

    const failure = RoutingFailureClassSchema.parse(request.failure)
    if (!policy.allowedFailures.includes(failure) || !FALLBACK_ELIGIBLE_FAILURES.has(failure)) {
      throw new ProviderCoreError(
        "PROVIDER_FALLBACK_NOT_ALLOWED",
        `Fallback is not allowed for ${failure}`,
        { failure },
      )
    }

    const attemptedWithRequested = uniqueProfileIds([...attempted, requested.id])
    for (const fallbackId of requested.fallbackProfiles) {
      if (attemptedWithRequested.includes(fallbackId)) {
        continue
      }
      const fallback = profiles.get(fallbackId)
      if (!fallback) {
        throw new ProviderCoreError(
          "PROVIDER_FALLBACK_PROFILE_UNKNOWN",
          `Fallback role profile ${fallbackId} does not exist`,
          { requestedProfileId: requested.id, fallbackProfileId: fallbackId },
        )
      }
      if (fallback.role !== requested.role) {
        throw new ProviderCoreError(
          "PROVIDER_FALLBACK_ROLE_MISMATCH",
          `Fallback role profile ${fallback.id} does not match role ${requested.role}`,
          {
            requestedProfileId: requested.id,
            fallbackProfileId: fallback.id,
            expectedRole: requested.role,
            actualRole: fallback.role,
          },
        )
      }

      const candidate = this.#candidateOrUnavailable(fallback, snapshot.providers, snapshot.models)
      if (!candidate) {
        continue
      }
      return this.#route(
        requested,
        candidate,
        snapshot.id,
        [...attemptedWithRequested, fallback.id],
        true,
        failure,
      )
    }

    throw new ProviderCoreError(
      "PROVIDER_FALLBACK_EXHAUSTED",
      `No eligible fallback role profile remains for ${requested.id}`,
      { requestedProfileId: requested.id, failure, attemptedProfiles: attemptedWithRequested },
    )
  }

  #parseProfiles(input: Readonly<Record<string, RoleProfile>>): Map<string, RoleProfile> {
    const profiles = new Map<string, RoleProfile>()
    for (const [key, value] of Object.entries(input)) {
      const profile = RoleProfileSchema.parse(value)
      if (profile.id !== key) {
        throw new ProviderCoreError(
          "PROVIDER_ROUTE_PROFILE_KEY_MISMATCH",
          `Role profile map key ${key} does not match profile id ${profile.id}`,
          { key, profileId: profile.id },
        )
      }
      profiles.set(key, profile)
    }
    return profiles
  }

  #candidate(
    profile: RoleProfile,
    providers: readonly ProviderInfo[],
    models: readonly ModelInfo[],
  ): RouteCandidate {
    const candidate = this.#candidateOrUnavailable(profile, providers, models)
    if (!candidate) {
      throw new ProviderCoreError(
        "PROVIDER_ROUTE_TARGET_UNAVAILABLE",
        `Provider or model selected by role profile ${profile.id} is unavailable`,
        { profileId: profile.id, providerId: profile.provider, modelId: profile.model },
      )
    }
    return candidate
  }

  #candidateOrUnavailable(
    profile: RoleProfile,
    providers: readonly ProviderInfo[],
    models: readonly ModelInfo[],
  ): RouteCandidate | undefined {
    if (profile.backend !== "embedded") {
      throw new ProviderCoreError(
        "PROVIDER_ROUTE_BACKEND_UNSUPPORTED",
        `Role profile ${profile.id} is not routed by the embedded provider catalog`,
        { profileId: profile.id, backend: profile.backend },
      )
    }

    const provider = providers.find((candidate) => candidate.id === profile.provider)
    const model = models.find(
      (candidate) => candidate.provider === profile.provider && candidate.id === profile.model,
    )
    if (!provider || !model) {
      return undefined
    }
    if (
      provider.status === "unavailable" ||
      provider.status === "deprecated" ||
      model.status === "unavailable" ||
      model.status === "deprecated"
    ) {
      return undefined
    }
    if (
      profile.variant !== undefined &&
      !model.variants.some((variant) => variant.id === profile.variant)
    ) {
      throw new ProviderCoreError(
        "PROVIDER_ROUTE_VARIANT_UNKNOWN",
        `Model ${profile.provider}/${profile.model} does not expose variant ${profile.variant}`,
        { profileId: profile.id, variant: profile.variant },
      )
    }
    if (!modelSatisfiesRequirements(model, profile.requirements)) {
      throw new ProviderCoreError(
        "PROVIDER_ROUTE_REQUIREMENTS_UNMET",
        `Model ${profile.provider}/${profile.model} does not satisfy role profile requirements`,
        { profileId: profile.id, providerId: profile.provider, modelId: profile.model },
      )
    }
    return { profile, provider, model }
  }

  #route(
    requested: RoleProfile,
    selected: RouteCandidate,
    snapshotId: string,
    attemptedProfiles: readonly string[],
    fallback: boolean,
    failure?: RoutingFailureClass,
  ): ResolvedModelRoute {
    return ResolvedModelRouteSchema.parse({
      schemaVersion: 1,
      requestedProfileId: requested.id,
      selectedProfileId: selected.profile.id,
      role: requested.role,
      provider: selected.provider,
      model: selected.model,
      profile: selected.profile,
      catalogSnapshotId: snapshotId,
      fallback,
      attemptedProfiles,
      reason: fallback
        ? `Fallback selected after ${failure ?? "eligible failure"}`
        : "Requested role profile selected",
    })
  }
}
