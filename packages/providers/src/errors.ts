export type ProviderCoreErrorDetails = Readonly<Record<string, unknown>>

export class ProviderCoreError extends Error {
  readonly code: string
  readonly details: ProviderCoreErrorDetails

  constructor(code: string, message: string, details: ProviderCoreErrorDetails = {}) {
    super(message)
    this.name = "ProviderCoreError"
    this.code = code
    this.details = details
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
