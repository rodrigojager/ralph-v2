import { z } from "zod"

function containsNoTerminalControls(value: string): boolean {
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && codePoint > 31 && (codePoint < 127 || codePoint > 159)
  })
}

const NonEmptyStringSchema = z
  .string()
  .trim()
  .min(1)
  .refine(containsNoTerminalControls, "Text cannot contain terminal control characters")
const SlugSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
const TimestampSchema = z.iso.datetime({ offset: true })

export const AuthMethodSchema = z.enum([
  "api-key",
  "environment",
  "oauth-browser",
  "device-code",
  "subscription-session",
  "existing-session",
  "external-cli",
])
export type AuthMethod = z.infer<typeof AuthMethodSchema>

export const CredentialStoreKindSchema = z.enum([
  "os-keychain",
  "secret-provider",
  "encrypted-file",
  "environment",
  "insecure-file",
])
export type CredentialStoreKind = z.infer<typeof CredentialStoreKindSchema>

export const CredentialRefSchema = z
  .object({
    id: SlugSchema,
    provider: SlugSchema,
    method: AuthMethodSchema,
    store: CredentialStoreKindSchema,
    locator: NonEmptyStringSchema,
    label: NonEmptyStringSchema,
    accountHint: NonEmptyStringSchema.optional(),
    expiresAt: TimestampSchema.optional(),
  })
  .strict()
export type CredentialRef = z.infer<typeof CredentialRefSchema>

export const CredentialMethodInfoSchema = z
  .object({
    method: AuthMethodSchema,
    label: NonEmptyStringSchema,
    access: z.array(z.enum(["api", "subscription"])).min(1),
    interactive: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.access).size !== value.access.length) {
      context.addIssue({
        code: "custom",
        message: "Access values must be unique",
        path: ["access"],
      })
    }
  })
export type CredentialMethodInfo = z.infer<typeof CredentialMethodInfoSchema>

export const CredentialConnectRequestSchema = z
  .object({
    id: SlugSchema.optional(),
    provider: SlugSchema,
    method: AuthMethodSchema,
    label: NonEmptyStringSchema.optional(),
    nonInteractive: z.boolean(),
  })
  .strict()
export type CredentialConnectRequest = z.infer<typeof CredentialConnectRequestSchema>

export const CredentialStatusSchema = z.enum([
  "connected",
  "expired",
  "unavailable",
  "revoked",
  "unknown",
])
export type CredentialStatus = z.infer<typeof CredentialStatusSchema>

export const SecretStoreProbeSchema = z
  .object({
    kind: CredentialStoreKindSchema,
    available: z.boolean(),
    backend: NonEmptyStringSchema,
    detail: NonEmptyStringSchema.optional(),
  })
  .strict()
export type SecretStoreProbe = z.infer<typeof SecretStoreProbeSchema>

export interface SecretStore {
  readonly kind: CredentialStoreKind
  probe(): Promise<SecretStoreProbe>
  put(locator: string, secret: string): Promise<void>
  get(locator: string): Promise<string | undefined>
  has(locator: string): Promise<boolean>
  delete(locator: string): Promise<void>
}

/**
 * A secret input is consumed exactly once and serializes only as a redaction marker.
 * CLI/TUI layers can implement it from stdin or a masked prompt without accepting argv values.
 */
export interface SecretInput {
  readOnce(): Promise<string>
  toJSON(): string
}

export interface ResolvedCredential {
  readonly ref: CredentialRef
  useValue<T>(consumer: (secretValue: string) => Promise<T>): Promise<T>
}

export interface CredentialDriver {
  readonly providerId: string
  methods(): Promise<readonly CredentialMethodInfo[]>
  connect(request: CredentialConnectRequest): Promise<CredentialRef>
  status(ref: CredentialRef): Promise<CredentialStatus>
  resolve(ref: CredentialRef): Promise<ResolvedCredential>
  renew(ref: CredentialRef): Promise<CredentialRef>
  revoke(ref: CredentialRef): Promise<void>
}

export type SecretConnectionMaterial = {
  kind: "secret"
  store: Exclude<CredentialStoreKind, "environment">
  secret: SecretInput
  accountHint?: string
  expiresAt?: string
}

export type EnvironmentConnectionMaterial = {
  kind: "environment"
  variable: string
  accountHint?: string
}

export type CredentialConnectionMaterial = SecretConnectionMaterial | EnvironmentConnectionMaterial

export interface CredentialConnectionBroker {
  connect(
    request: CredentialConnectRequest,
    method: CredentialMethodInfo,
  ): Promise<CredentialConnectionMaterial>
  renew?(ref: CredentialRef, currentSecret: string): Promise<SecretConnectionMaterial>
  revoke?(ref: CredentialRef, currentSecret: string | undefined): Promise<void>
}

export const CredentialMetadataDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    credentials: z.array(CredentialRefSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.credentials.map((credential) => credential.id)
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "Credential IDs must be unique",
        path: ["credentials"],
      })
    }
  })
export type CredentialMetadataDocument = z.infer<typeof CredentialMetadataDocumentSchema>
