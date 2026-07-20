import type { CredentialStoreKind, SecretStore, SecretStoreProbe } from "./contracts"

export class FakeSecretStore implements SecretStore {
  readonly kind: CredentialStoreKind
  readonly values = new Map<string, string>()
  available = true

  constructor(kind: CredentialStoreKind = "os-keychain") {
    this.kind = kind
  }

  async probe(): Promise<SecretStoreProbe> {
    return {
      kind: this.kind,
      available: this.available,
      backend: "fake",
      ...(!this.available ? { detail: "Fake secret store is unavailable" } : {}),
    }
  }

  async put(locator: string, secret: string): Promise<void> {
    this.assertAvailable()
    this.values.set(locator, secret)
  }

  async get(locator: string): Promise<string | undefined> {
    this.assertAvailable()
    return this.values.get(locator)
  }

  async has(locator: string): Promise<boolean> {
    this.assertAvailable()
    return this.values.has(locator)
  }

  async delete(locator: string): Promise<void> {
    this.assertAvailable()
    this.values.delete(locator)
  }

  private assertAvailable(): void {
    if (!this.available) throw new Error("Fake secret store is unavailable")
  }
}
