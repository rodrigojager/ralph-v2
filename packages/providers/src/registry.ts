import type { ProviderDriver } from "./contracts"
import { ProviderCoreError } from "./errors"

export type ProviderDriverLoader = () => ProviderDriver | Promise<ProviderDriver>

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const DRIVER_METHODS = ["info", "listModels", "credentialDriver", "invoke", "cancel"] as const

export function validateProviderDriverContract(
  value: unknown,
  expectedId?: string,
): asserts value is ProviderDriver {
  if (typeof value !== "object" || value === null) {
    throw new ProviderCoreError(
      "PROVIDER_DRIVER_INVALID",
      "Provider loader did not return a driver object",
    )
  }

  const candidate = value as Record<string, unknown>
  if (typeof candidate.id !== "string" || !PROVIDER_ID_PATTERN.test(candidate.id)) {
    throw new ProviderCoreError(
      "PROVIDER_DRIVER_INVALID",
      "Provider driver must expose a valid provider id",
    )
  }
  if (expectedId !== undefined && candidate.id !== expectedId) {
    throw new ProviderCoreError(
      "PROVIDER_DRIVER_ID_MISMATCH",
      `Provider driver id ${candidate.id} does not match registry id ${expectedId}`,
      { expectedId, actualId: candidate.id },
    )
  }

  for (const method of DRIVER_METHODS) {
    if (typeof candidate[method] !== "function") {
      throw new ProviderCoreError(
        "PROVIDER_DRIVER_INVALID",
        `Provider driver ${candidate.id} is missing method ${method}`,
        { providerId: candidate.id, method },
      )
    }
  }
}

export class LazyProviderRegistry {
  readonly #loaders = new Map<string, ProviderDriverLoader>()
  readonly #loaded = new Map<string, Promise<ProviderDriver>>()

  register(id: string, loader: ProviderDriverLoader): void {
    if (!PROVIDER_ID_PATTERN.test(id)) {
      throw new ProviderCoreError(
        "PROVIDER_REGISTRY_ID_INVALID",
        `Invalid provider registry id: ${id}`,
        { providerId: id },
      )
    }
    if (typeof loader !== "function") {
      throw new ProviderCoreError(
        "PROVIDER_REGISTRY_LOADER_INVALID",
        `Provider ${id} must be registered with a loader`,
        { providerId: id },
      )
    }
    if (this.#loaders.has(id)) {
      throw new ProviderCoreError(
        "PROVIDER_REGISTRY_DUPLICATE",
        `Provider ${id} is already registered`,
        { providerId: id },
      )
    }
    this.#loaders.set(id, loader)
  }

  has(id: string): boolean {
    return this.#loaders.has(id)
  }

  ids(): readonly string[] {
    return [...this.#loaders.keys()].sort((left, right) => left.localeCompare(right))
  }

  async resolve(id: string): Promise<ProviderDriver | undefined> {
    const loader = this.#loaders.get(id)
    if (!loader) {
      return undefined
    }

    const existing = this.#loaded.get(id)
    if (existing) {
      return existing
    }

    const pending = Promise.resolve()
      .then(loader)
      .then((driver) => {
        validateProviderDriverContract(driver, id)
        return driver
      })

    this.#loaded.set(id, pending)
    try {
      return await pending
    } catch (error) {
      if (this.#loaded.get(id) === pending) {
        this.#loaded.delete(id)
      }
      throw error
    }
  }

  async require(id: string): Promise<ProviderDriver> {
    const driver = await this.resolve(id)
    if (!driver) {
      throw new ProviderCoreError("PROVIDER_NOT_REGISTERED", `Provider ${id} is not registered`, {
        providerId: id,
      })
    }
    return driver
  }
}
