import { createHash } from "node:crypto"
import { lstat, readFile, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { z } from "zod"
import { sha256File } from "./build-artifact"

export const GITLEAKS_VERSION = "8.30.1"
export const GITLEAKS_ARCHIVE_SHA256 =
  "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
export const GITLEAKS_LINUX_X64_BINARY_SHA256 =
  "88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509"
export const GITLEAKS_LINUX_X64_BINARY_BYTES = 21_958_840
export const GITLEAKS_SOURCE =
  "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/" +
  "gitleaks_8.30.1_linux_x64.tar.gz"

const sha256Pattern = /^[a-f0-9]{64}$/u
const maximumReportBytes = 16 * 1024 * 1024
const InstallReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactClass: z.literal("pinned-ci-tool-install"),
    tool: z.literal("gitleaks"),
    version: z.literal(GITLEAKS_VERSION),
    source: z.literal(GITLEAKS_SOURCE),
    archiveSha256: z.literal(GITLEAKS_ARCHIVE_SHA256),
    binaryPath: z.literal("artifacts/ci/tooling/bin/gitleaks"),
    binaryBytes: z.literal(GITLEAKS_LINUX_X64_BINARY_BYTES),
    binarySha256: z.literal(GITLEAKS_LINUX_X64_BINARY_SHA256),
    reportedVersion: z.literal(GITLEAKS_VERSION),
  })
  .strict()

export interface GitleaksBinding {
  readonly binary: string
  readonly sha256: string
  readonly version: typeof GITLEAKS_VERSION
  readonly provenance:
    | { readonly kind: "explicit-hash" }
    | {
        readonly kind: "checksum-pinned-official-install-receipt"
        readonly receipt: string
        readonly receiptBytes: number
        readonly receiptSha256: string
        readonly source: typeof GITLEAKS_SOURCE
        readonly archiveSha256: typeof GITLEAKS_ARCHIVE_SHA256
      }
}

function insideProject(projectRoot: string, path: string): boolean {
  const projectRelative = relative(projectRoot, path)
  return (
    projectRelative !== ".." &&
    !projectRelative.startsWith(`..${sep}`) &&
    !isAbsolute(projectRelative)
  )
}

function samePath(left: string, right: string): boolean {
  const comparable = (value: string) => {
    const absolute = resolve(value)
    return process.platform === "win32" ? absolute.toLocaleLowerCase("und") : absolute
  }
  return comparable(left) === comparable(right)
}

async function exactRegularFile(
  path: string,
  expectedSha256: string,
  expectedBytes?: number,
): Promise<string> {
  const requested = resolve(path)
  const info = await lstat(requested)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Gitleaks binary must be a regular non-symlink file")
  }
  const canonical = await realpath(requested)
  if (!samePath(canonical, requested)) {
    throw new Error("Gitleaks binary path must not resolve through a link or junction")
  }
  if (expectedBytes !== undefined && info.size !== expectedBytes) {
    throw new Error(`Gitleaks binary size mismatch: expected ${expectedBytes}, got ${info.size}`)
  }
  const observed = await sha256File(canonical)
  if (observed !== expectedSha256) {
    throw new Error(`Gitleaks binary SHA-256 mismatch: expected ${expectedSha256}, got ${observed}`)
  }
  return canonical
}

export async function resolveGitleaksBinding(input: {
  readonly projectRoot: string
  readonly explicitBinary?: string
  readonly explicitSha256?: string
}): Promise<GitleaksBinding> {
  const root = resolve(input.projectRoot)
  if (Boolean(input.explicitBinary) !== Boolean(input.explicitSha256)) {
    throw new Error("Explicit Gitleaks binary and SHA-256 must be supplied together")
  }
  if (input.explicitBinary && input.explicitSha256) {
    if (!sha256Pattern.test(input.explicitSha256)) {
      throw new Error("Explicit Gitleaks SHA-256 must be lowercase hexadecimal")
    }
    return {
      binary: await exactRegularFile(resolve(input.explicitBinary), input.explicitSha256),
      sha256: input.explicitSha256,
      version: GITLEAKS_VERSION,
      provenance: { kind: "explicit-hash" },
    }
  }

  const receiptPath = resolve(root, "artifacts", "ci", "tooling", "gitleaks-install.json")
  const receiptBefore = await lstat(receiptPath)
  if (
    !receiptBefore.isFile() ||
    receiptBefore.isSymbolicLink() ||
    receiptBefore.size > 64 * 1024 ||
    !samePath(await realpath(receiptPath), receiptPath)
  ) {
    throw new Error("Pinned Gitleaks install receipt must be a regular non-symlink file")
  }
  const receiptBytes = await readFile(receiptPath)
  const receiptAfter = await lstat(receiptPath)
  if (
    !receiptAfter.isFile() ||
    receiptAfter.isSymbolicLink() ||
    receiptAfter.dev !== receiptBefore.dev ||
    receiptAfter.ino !== receiptBefore.ino ||
    receiptAfter.size !== receiptBefore.size ||
    receiptAfter.mtimeMs !== receiptBefore.mtimeMs ||
    receiptAfter.ctimeMs !== receiptBefore.ctimeMs
  ) {
    throw new Error("Pinned Gitleaks install receipt changed while it was read")
  }
  const receipt = InstallReceiptSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(receiptBytes)),
  )
  const binaryPath = resolve(root, receipt.binaryPath)
  if (!insideProject(root, binaryPath)) throw new Error("Pinned Gitleaks binary escaped the project")
  return {
    binary: await exactRegularFile(binaryPath, receipt.binarySha256, receipt.binaryBytes),
    sha256: receipt.binarySha256,
    version: GITLEAKS_VERSION,
    provenance: {
      kind: "checksum-pinned-official-install-receipt",
      receipt: relative(root, receiptPath).replaceAll("\\", "/"),
      receiptBytes: receiptBytes.byteLength,
      receiptSha256: createHash("sha256").update(receiptBytes).digest("hex"),
      source: GITLEAKS_SOURCE,
      archiveSha256: GITLEAKS_ARCHIVE_SHA256,
    },
  }
}

export function validateGitleaksVersionOutput(value: string): void {
  if (value.trim() !== GITLEAKS_VERSION) {
    throw new Error(`Gitleaks reported an unexpected version: ${value.trim() || "<empty>"}`)
  }
}

export function gitleaksTrackedSourceScanArguments(reportPath: string): readonly string[] {
  return [
    "git",
    ".",
    "--no-banner",
    "--no-color",
    "--redact=100",
    "--timeout",
    "120",
    "--report-format",
    "json",
    "--report-path",
    reportPath,
  ]
}

export async function validateEmptyGitleaksReport(path: string): Promise<{
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  readonly findings: 0
}> {
  const requested = resolve(path)
  const info = await lstat(requested)
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximumReportBytes) {
    throw new Error("Gitleaks report must be a bounded regular non-symlink JSON file")
  }
  if (!samePath(await realpath(requested), requested)) {
    throw new Error("Gitleaks report path resolves through a link or junction")
  }
  const bytes = await readFile(requested)
  const after = await lstat(requested)
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.dev !== info.dev ||
    after.ino !== info.ino ||
    after.size !== info.size ||
    after.mtimeMs !== info.mtimeMs ||
    after.ctimeMs !== info.ctimeMs
  ) {
    throw new Error("Gitleaks report changed while it was read")
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
  if (!Array.isArray(value) || value.length !== 0) {
    throw new Error("Gitleaks report must be an empty findings array")
  }
  return {
    path: requested,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    findings: 0,
  }
}
