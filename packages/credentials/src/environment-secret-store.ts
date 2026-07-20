import type { SecretStore, SecretStoreProbe } from "./contracts"

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export class EnvironmentSecretStore implements SecretStore {
  readonly kind = "environment" as const

  constructor(private readonly environment: Record<string, string | undefined> = process.env) {}

  async probe(): Promise<SecretStoreProbe> {
    return { kind: this.kind, available: true, backend: "process-environment" }
  }

  async put(locator: string, secret: string): Promise<void> {
    void locator
    void secret
    throw new Error("Environment references are read-only and cannot persist secrets")
  }

  async get(locator: string): Promise<string | undefined> {
    this.validate(locator)
    return this.environment[locator]
  }

  async has(locator: string): Promise<boolean> {
    this.validate(locator)
    return this.environment[locator] !== undefined
  }

  async delete(locator: string): Promise<void> {
    this.validate(locator)
    // Revoking an environment reference removes Ralph metadata only. Mutating the
    // parent process environment would not revoke the source and would be misleading.
  }

  private validate(locator: string): void {
    if (!ENVIRONMENT_NAME.test(locator)) {
      throw new Error(`Invalid environment credential locator: ${locator}`)
    }
  }
}
