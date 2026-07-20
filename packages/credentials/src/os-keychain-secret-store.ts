import type { SecretStore, SecretStoreProbe } from "./contracts"
import { SecretRedactor } from "./redaction"
import {
  BunSecretProcessRunner,
  type SecretProcessRequest,
  type SecretProcessResult,
  type SecretProcessRunner,
} from "./secret-process"

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/
const WINDOWS_MISSING_HRESULT = -2147023728
const WINDOWS_MISSING = "__RALPH_CREDENTIAL_MISSING__"
const DEFAULT_TIMEOUT_MS = 15_000

const WINDOWS_PROBE = `
$ErrorActionPreference = "Stop"
$vault = [Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]::new()
[Console]::Out.Write("ok")
`

const WINDOWS_PUT = `
$ErrorActionPreference = "Stop"
function Test-CredentialMissing([System.Exception]$exception) {
  while ($null -ne $exception) {
    if ($exception.HResult -eq ${WINDOWS_MISSING_HRESULT}) { return $true }
    $exception = $exception.InnerException
  }
  return $false
}
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$vault = [Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]::new()
try {
  $existing = $vault.Retrieve([string]$payload.resource, [string]$payload.locator)
  $vault.Remove($existing)
} catch {
  if (-not (Test-CredentialMissing $_.Exception)) { throw }
}
$credential = [Windows.Security.Credentials.PasswordCredential,Windows.Security.Credentials,ContentType=WindowsRuntime]::new(
  [string]$payload.resource,
  [string]$payload.locator,
  [string]$payload.secret
)
$vault.Add($credential)
`

const WINDOWS_GET = `
$ErrorActionPreference = "Stop"
function Test-CredentialMissing([System.Exception]$exception) {
  while ($null -ne $exception) {
    if ($exception.HResult -eq ${WINDOWS_MISSING_HRESULT}) { return $true }
    $exception = $exception.InnerException
  }
  return $false
}
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$vault = [Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]::new()
try {
  $credential = $vault.Retrieve([string]$payload.resource, [string]$payload.locator)
  $credential.RetrievePassword()
  [Console]::Out.Write($credential.Password)
} catch {
  if (Test-CredentialMissing $_.Exception) {
    [Console]::Out.Write("${WINDOWS_MISSING}")
    exit 0
  }
  throw
}
`

const WINDOWS_DELETE = `
$ErrorActionPreference = "Stop"
function Test-CredentialMissing([System.Exception]$exception) {
  while ($null -ne $exception) {
    if ($exception.HResult -eq ${WINDOWS_MISSING_HRESULT}) { return $true }
    $exception = $exception.InnerException
  }
  return $false
}
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$vault = [Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]::new()
try {
  $credential = $vault.Retrieve([string]$payload.resource, [string]$payload.locator)
  $vault.Remove($credential)
} catch {
  if (-not (Test-CredentialMissing $_.Exception)) { throw }
}
`

export type OsKeychainSecretStoreOptions = {
  platform?: NodeJS.Platform
  runner?: SecretProcessRunner
  service?: string
  timeoutMs?: number
  windowsExecutable?: string
  macosExecutable?: string
  linuxExecutable?: string
}

export class OsKeychainSecretStore implements SecretStore {
  readonly kind = "os-keychain" as const
  readonly #platform: NodeJS.Platform
  readonly #runner: SecretProcessRunner
  readonly #service: string
  readonly #timeoutMs: number
  readonly #windowsExecutable: string
  readonly #macosExecutable: string
  readonly #linuxExecutable: string
  readonly #redactor = new SecretRedactor()

  constructor(options: OsKeychainSecretStoreOptions = {}) {
    this.#platform = options.platform ?? process.platform
    this.#runner = options.runner ?? new BunSecretProcessRunner()
    this.#service = options.service ?? "ralph-v2"
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#windowsExecutable = options.windowsExecutable ?? "powershell.exe"
    this.#macosExecutable = options.macosExecutable ?? "/usr/bin/security"
    this.#linuxExecutable = options.linuxExecutable ?? "secret-tool"
    this.validateIdentifier(this.#service, "service")
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new Error("OS keychain timeout must be a positive safe integer")
    }
  }

  async probe(): Promise<SecretStoreProbe> {
    try {
      const request = this.probeRequest()
      if (!request) {
        return {
          kind: this.kind,
          available: false,
          backend: `unsupported:${this.#platform}`,
          detail: `OS credential store is unsupported on ${this.#platform}`,
        }
      }
      const result = await this.#runner.run(request)
      if (result.timedOut || result.exitCode !== 0) {
        return {
          kind: this.kind,
          available: false,
          backend: this.backend(),
          detail: result.timedOut
            ? "OS credential store probe timed out"
            : this.diagnostic("OS credential store probe failed", result),
        }
      }
      return { kind: this.kind, available: true, backend: this.backend() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        kind: this.kind,
        available: false,
        backend: this.backend(),
        detail: this.#redactor.redactText(message).slice(0, 512),
      }
    }
  }

  async put(locator: string, secret: string): Promise<void> {
    this.validateIdentifier(locator, "locator")
    if (secret.length === 0) throw new Error("OS keychain secret cannot be empty")
    await this.ensureAvailable()
    const result = await this.#runner.run(this.putRequest(locator, secret))
    this.ensureSuccess("store", result, [secret])
  }

  async get(locator: string): Promise<string | undefined> {
    this.validateIdentifier(locator, "locator")
    await this.ensureAvailable()
    const result = await this.#runner.run(this.getRequest(locator))
    if (this.#platform === "darwin" && result.exitCode === 44) return undefined
    if (
      this.#platform === "linux" &&
      result.exitCode === 1 &&
      result.stdout.length === 0 &&
      result.stderr.length === 0
    ) {
      return undefined
    }
    this.ensureSuccess("read", result)
    if (this.#platform === "win32")
      return result.stdout === WINDOWS_MISSING ? undefined : result.stdout
    const value = result.stdout.replace(/\r?\n$/, "")
    if (this.#platform === "darwin") {
      if (value.length === 0) return ""
      try {
        const decoded = Buffer.from(value, "base64")
        if (
          decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "") ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
        ) {
          throw new Error("invalid base64")
        }
        return new TextDecoder("utf-8", { fatal: true }).decode(decoded)
      } catch (error) {
        throw new Error("macOS keychain returned invalid secret encoding", { cause: error })
      }
    }
    return value
  }

  async has(locator: string): Promise<boolean> {
    return (await this.get(locator)) !== undefined
  }

  async delete(locator: string): Promise<void> {
    this.validateIdentifier(locator, "locator")
    await this.ensureAvailable()
    const result = await this.#runner.run(this.deleteRequest(locator))
    if (this.#platform === "darwin" && result.exitCode === 44) return
    if (this.#platform === "linux" && result.exitCode === 1 && result.stderr.length === 0) return
    this.ensureSuccess("delete", result)
  }

  private probeRequest(): SecretProcessRequest | undefined {
    if (this.#platform === "win32") return this.windowsRequest(WINDOWS_PROBE)
    if (this.#platform === "darwin") {
      return this.request(this.#macosExecutable, ["list-keychains"])
    }
    if (this.#platform === "linux") return this.request(this.#linuxExecutable, ["--help"])
    return undefined
  }

  private putRequest(locator: string, secret: string): SecretProcessRequest {
    if (this.#platform === "win32") {
      return this.windowsRequest(
        WINDOWS_PUT,
        JSON.stringify({ resource: this.#service, locator, secret }),
      )
    }
    if (this.#platform === "darwin") {
      const encoded = Buffer.from(secret, "utf8").toString("base64")
      return this.request(
        this.#macosExecutable,
        ["add-generic-password", "-U", "-a", locator, "-s", this.#service, "-w"],
        `${encoded}\n${encoded}\n`,
      )
    }
    if (this.#platform === "linux") {
      return this.request(
        this.#linuxExecutable,
        ["store", "--label", this.#service, "service", this.#service, "locator", locator],
        secret,
      )
    }
    throw new Error(`OS credential store is unsupported on ${this.#platform}`)
  }

  private getRequest(locator: string): SecretProcessRequest {
    if (this.#platform === "win32") {
      return this.windowsRequest(WINDOWS_GET, JSON.stringify({ resource: this.#service, locator }))
    }
    if (this.#platform === "darwin") {
      return this.request(this.#macosExecutable, [
        "find-generic-password",
        "-a",
        locator,
        "-s",
        this.#service,
        "-w",
      ])
    }
    if (this.#platform === "linux") {
      return this.request(this.#linuxExecutable, [
        "lookup",
        "service",
        this.#service,
        "locator",
        locator,
      ])
    }
    throw new Error(`OS credential store is unsupported on ${this.#platform}`)
  }

  private deleteRequest(locator: string): SecretProcessRequest {
    if (this.#platform === "win32") {
      return this.windowsRequest(
        WINDOWS_DELETE,
        JSON.stringify({ resource: this.#service, locator }),
      )
    }
    if (this.#platform === "darwin") {
      return this.request(this.#macosExecutable, [
        "delete-generic-password",
        "-a",
        locator,
        "-s",
        this.#service,
      ])
    }
    if (this.#platform === "linux") {
      return this.request(this.#linuxExecutable, [
        "clear",
        "service",
        this.#service,
        "locator",
        locator,
      ])
    }
    throw new Error(`OS credential store is unsupported on ${this.#platform}`)
  }

  private windowsRequest(script: string, stdin?: string): SecretProcessRequest {
    const encoded = Buffer.from(script, "utf16le").toString("base64")
    return this.request(
      this.#windowsExecutable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encoded,
      ],
      stdin,
    )
  }

  private request(
    executable: string,
    args: readonly string[],
    stdin?: string,
  ): SecretProcessRequest {
    return {
      executable,
      args,
      timeoutMs: this.#timeoutMs,
      ...(stdin !== undefined ? { stdin } : {}),
    }
  }

  private async ensureAvailable(): Promise<void> {
    const probe = await this.probe()
    if (!probe.available)
      throw new Error(probe.detail ?? `OS credential store is unavailable: ${probe.backend}`)
  }

  private ensureSuccess(
    operation: string,
    result: SecretProcessResult,
    secrets: readonly string[] = [],
  ): void {
    if (!result.timedOut && result.exitCode === 0) return
    throw new Error(this.diagnostic(`OS credential ${operation} failed`, result, secrets))
  }

  private diagnostic(
    prefix: string,
    result: SecretProcessResult,
    secrets: readonly string[] = [],
  ): string {
    if (result.timedOut) return `${prefix}: timed out`
    const detail = this.#redactor.redactText(result.stderr.trim(), secrets).slice(0, 512)
    return `${prefix} (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`
  }

  private backend(): string {
    if (this.#platform === "win32") return `windows-password-vault:${this.#windowsExecutable}`
    if (this.#platform === "darwin") return `macos-keychain:${this.#macosExecutable}`
    if (this.#platform === "linux") return `linux-secret-service:${this.#linuxExecutable}`
    return `unsupported:${this.#platform}`
  }

  private validateIdentifier(value: string, field: string): void {
    if (!SAFE_IDENTIFIER.test(value)) throw new Error(`Invalid OS keychain ${field}`)
  }
}
