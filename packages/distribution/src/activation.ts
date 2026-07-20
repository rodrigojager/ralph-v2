import { isAbsolute, relative, resolve, sep } from "node:path"
import {
  type CurrentInstallPointer,
  CurrentInstallPointerSchema,
  type InstallReceipt,
  InstallReceiptSchema,
} from "./contracts"

function portableRelative(parent: string, candidate: string): string {
  const path = relative(parent, candidate)
  if (path === "" || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`Activated executable escapes install root: ${candidate}`)
  }
  return path.replaceAll("\\", "/")
}

export function buildCurrentInstallPointer(
  rawReceipt: InstallReceipt,
  receiptPath: string,
  receiptSha256: string,
  version: string,
  activatedAt: string,
): CurrentInstallPointer {
  const receipt = InstallReceiptSchema.parse(rawReceipt)
  const installed = receipt.versions.find((entry) => entry.version === version)
  if (!installed) throw new Error(`Version is absent from install receipt: ${version}`)
  const root = resolve(receipt.installRoot)
  const executable = resolve(installed.executable)
  return CurrentInstallPointerSchema.parse({
    schemaVersion: 1,
    installId: receipt.installId,
    product: "ralph-next",
    generation: receipt.generation,
    receipt: portableRelative(root, resolve(receiptPath)),
    receiptSha256,
    version: installed.version,
    target: installed.target,
    executable: portableRelative(root, executable),
    sha256: installed.sha256,
    activatedAt,
  })
}

export function serializeDistributionControlFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}
