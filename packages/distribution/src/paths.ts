import { isAbsolute, parse, relative, resolve, sep } from "node:path"
import { EXIT_CODES, RalphError } from "@ralph/domain"
import { type InstallReceipt, InstallReceiptSchema } from "./contracts"

export interface StandaloneInstallLayout {
  readonly root: string
  readonly receipts: string
  readonly currentPointer: string
  readonly bin: string
  readonly launcher: string
  readonly versions: string
  readonly staging: string
  readonly rollback: string
}

function distributionError(code: string, message: string, details?: Record<string, unknown>) {
  return new RalphError(code, message, {
    exitCode: EXIT_CODES.invalidUsage,
    ...(details ? { details } : {}),
  })
}

function pathIsInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate)
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

export function resolveStandaloneInstallLayout(
  requestedRoot: string,
  platform: NodeJS.Platform = process.platform,
): StandaloneInstallLayout {
  if (requestedRoot.trim().length === 0) {
    throw distributionError("RALPH_INSTALL_ROOT_REQUIRED", "Install root cannot be empty")
  }
  const root = resolve(requestedRoot)
  if (root === parse(root).root) {
    throw distributionError(
      "RALPH_INSTALL_ROOT_TOO_BROAD",
      `Install root cannot be a filesystem root: ${root}`,
      { file: root },
    )
  }
  const bin = resolve(root, "bin")
  return {
    root,
    receipts: resolve(root, "receipts"),
    currentPointer: resolve(root, "current.json"),
    bin,
    launcher: resolve(bin, platform === "win32" ? "ralph.exe" : "ralph"),
    versions: resolve(root, "versions"),
    staging: resolve(root, "staging"),
    rollback: resolve(root, "rollback"),
  }
}

export function assertManagedInstallPath(
  layout: StandaloneInstallLayout,
  candidate: string,
): string {
  const resolved = resolve(candidate)
  if (!pathIsInside(layout.root, resolved)) {
    throw distributionError(
      "RALPH_INSTALL_MANAGED_PATH_ESCAPE",
      `Managed install path escapes the identified install root: ${resolved}`,
      { file: resolved, installRoot: layout.root },
    )
  }
  return resolved
}

export function versionDirectory(layout: StandaloneInstallLayout, version: string): string {
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(
      version,
    )
  ) {
    throw distributionError("RALPH_INSTALL_VERSION_INVALID", `Invalid release version: ${version}`)
  }
  return assertManagedInstallPath(layout, resolve(layout.versions, version))
}

export function validateInstallReceiptPaths(
  rawReceipt: unknown,
  requestedRoot: string,
  receiptPath?: string,
): InstallReceipt {
  const receipt = InstallReceiptSchema.parse(rawReceipt)
  const layout = resolveStandaloneInstallLayout(requestedRoot)
  if (resolve(receipt.installRoot) !== layout.root) {
    throw distributionError(
      "RALPH_INSTALL_RECEIPT_ROOT_MISMATCH",
      `Install receipt belongs to a different root: ${receipt.installRoot}`,
      { file: receipt.installRoot, expected: layout.root },
    )
  }
  const paths = new Set<string>()
  for (const managedPath of receipt.managedPaths) {
    const resolved = assertManagedInstallPath(layout, managedPath)
    if (paths.has(resolved)) {
      throw distributionError(
        "RALPH_INSTALL_RECEIPT_PATH_DUPLICATE",
        `Install receipt repeats a managed path: ${resolved}`,
        { file: resolved },
      )
    }
    paths.add(resolved)
  }
  for (const installed of receipt.versions) {
    const directory = assertManagedInstallPath(layout, installed.directory)
    if (directory !== versionDirectory(layout, installed.version)) {
      throw distributionError(
        "RALPH_INSTALL_RECEIPT_VERSION_DIRECTORY_MISMATCH",
        `Installed version directory does not match its version: ${directory}`,
        { file: directory, version: installed.version },
      )
    }
    const executable = assertManagedInstallPath(layout, installed.executable)
    if (!pathIsInside(directory, executable)) {
      throw distributionError(
        "RALPH_INSTALL_RECEIPT_EXECUTABLE_ESCAPE",
        `Installed executable is outside its immutable version directory: ${executable}`,
        { file: executable, directory },
      )
    }
    const filePaths = new Set<string>()
    for (const file of installed.files) {
      const filePath = assertManagedInstallPath(layout, file.path)
      if (!pathIsInside(directory, filePath)) {
        throw distributionError(
          "RALPH_INSTALL_RECEIPT_VERSION_FILE_ESCAPE",
          `Installed version file is outside its immutable directory: ${filePath}`,
          { file: filePath, directory },
        )
      }
      if (filePaths.has(filePath)) {
        throw distributionError(
          "RALPH_INSTALL_RECEIPT_VERSION_FILE_DUPLICATE",
          `Installed version repeats a file: ${filePath}`,
          { file: filePath },
        )
      }
      filePaths.add(filePath)
    }
    const executableFile = installed.files.find((file) => file.role === "executable")
    if (
      !executableFile ||
      resolve(executableFile.path) !== executable ||
      executableFile.sha256 !== installed.sha256
    ) {
      throw distributionError(
        "RALPH_INSTALL_RECEIPT_EXECUTABLE_FILE_MISMATCH",
        `Installed executable does not match its file receipt: ${executable}`,
        { file: executable },
      )
    }
  }
  const currentExecutable = assertManagedInstallPath(layout, receipt.currentExecutable)
  const launcher = assertManagedInstallPath(layout, receipt.launcher.executable)
  if (launcher !== layout.launcher) {
    throw distributionError(
      "RALPH_INSTALL_RECEIPT_LAUNCHER_MISMATCH",
      `Install receipt launcher does not match the stable launcher path: ${launcher}`,
      { file: launcher, expected: layout.launcher },
    )
  }
  const current = receipt.versions.find((entry) => entry.version === receipt.currentVersion)
  if (!current || resolve(current.executable) !== currentExecutable) {
    throw distributionError(
      "RALPH_INSTALL_RECEIPT_CURRENT_MISMATCH",
      "Install receipt current executable does not match its current version entry",
      { file: currentExecutable },
    )
  }
  const requiredPaths = [layout.currentPointer, layout.launcher]
  if (receiptPath) {
    const resolvedReceipt = assertManagedInstallPath(layout, receiptPath)
    if (!pathIsInside(layout.receipts, resolvedReceipt)) {
      throw distributionError(
        "RALPH_INSTALL_RECEIPT_FILE_ESCAPE",
        `Immutable receipt file is outside receipts/: ${resolvedReceipt}`,
        { file: resolvedReceipt },
      )
    }
    requiredPaths.push(resolvedReceipt)
  }
  for (const requiredPath of requiredPaths) {
    if (!paths.has(requiredPath)) {
      throw distributionError(
        "RALPH_INSTALL_RECEIPT_MANAGED_PATH_MISSING",
        `Install receipt omits a required managed path: ${requiredPath}`,
        { file: requiredPath },
      )
    }
  }
  return receipt
}
