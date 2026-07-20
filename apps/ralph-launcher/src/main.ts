import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, readFile, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { CurrentInstallPointerSchema, InstallReceiptSchema } from "@ralph-next/distribution"

const MAX_CONTROL_FILE_BYTES = 1024 * 1024

function inside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate)
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

async function readRegularJson(path: string): Promise<unknown> {
  return JSON.parse(await readRegularText(path))
}

async function readRegularText(path: string): Promise<string> {
  const information = await lstat(path)
  if (!information.isFile() || information.isSymbolicLink()) {
    throw new Error(`control file is not a regular file: ${path}`)
  }
  if (information.size <= 0 || information.size > MAX_CONTROL_FILE_BYTES) {
    throw new Error(`control file size is invalid: ${path}`)
  }
  return readFile(path, "utf8")
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

async function launch(): Promise<number> {
  const launcher = await realpath(process.execPath)
  const installRoot = await realpath(resolve(dirname(launcher), ".."))
  const versionsRoot = await realpath(resolve(installRoot, "versions"))
  const receiptsRoot = await realpath(resolve(installRoot, "receipts"))
  const pointer = CurrentInstallPointerSchema.parse(
    await readRegularJson(resolve(installRoot, "current.json")),
  )
  const requestedReceipt = resolve(installRoot, pointer.receipt)
  const receiptInformation = await lstat(requestedReceipt)
  if (!receiptInformation.isFile() || receiptInformation.isSymbolicLink()) {
    throw new Error("current receipt is not a regular immutable file")
  }
  const receiptPath = await realpath(requestedReceipt)
  if (!inside(receiptsRoot, receiptPath)) {
    throw new Error("current receipt escapes the immutable receipt directory")
  }
  const receiptText = await readRegularText(receiptPath)
  const receiptSha256 = createHash("sha256").update(receiptText).digest("hex")
  if (receiptSha256 !== pointer.receiptSha256) {
    throw new Error("current receipt SHA-256 does not match the atomic pointer")
  }
  const receipt = InstallReceiptSchema.parse(JSON.parse(receiptText))
  if (resolve(receipt.installRoot) !== installRoot || receipt.installId !== pointer.installId) {
    throw new Error("install receipt and current pointer identity do not match this launcher")
  }
  if (receipt.generation !== pointer.generation) {
    throw new Error("install receipt generation does not match the atomic pointer")
  }
  if (
    receipt.launcher.schemaVersion !== 1 ||
    resolve(receipt.launcher.executable) !== launcher ||
    (await sha256File(launcher)) !== receipt.launcher.sha256
  ) {
    throw new Error("launcher identity or SHA-256 does not match the install receipt")
  }
  if (receipt.currentVersion !== pointer.version || receipt.currentTarget !== pointer.target) {
    throw new Error("install receipt and current pointer select different versions or targets")
  }
  const receiptVersion = receipt.versions.find((entry) => entry.version === pointer.version)
  if (!receiptVersion || receiptVersion.sha256 !== pointer.sha256) {
    throw new Error("current version is absent or hash-mismatched in the install receipt")
  }
  const requestedExecutable = resolve(installRoot, pointer.executable)
  const requestedInformation = await lstat(requestedExecutable)
  if (!requestedInformation.isFile() || requestedInformation.isSymbolicLink()) {
    throw new Error("current executable is not a regular file")
  }
  const executable = await realpath(requestedExecutable)
  if (
    !inside(versionsRoot, executable) ||
    resolve(receiptVersion.executable) !== executable ||
    resolve(receipt.currentExecutable) !== executable
  ) {
    throw new Error("current executable escapes its receipt-bound immutable version directory")
  }
  const actualSha256 = await sha256File(executable)
  if (actualSha256 !== pointer.sha256) {
    throw new Error("current executable SHA-256 does not match the activated pointer")
  }

  const child = Bun.spawn([executable, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RALPH_STANDALONE_INSTALL_ROOT: installRoot,
      RALPH_STANDALONE_LAUNCHER_PID: String(process.pid),
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    windowsHide: true,
  })
  const forward = (signal: NodeJS.Signals) => {
    try {
      child.kill(signal)
    } catch {
      // The child may have already settled; its exit code remains authoritative.
    }
  }
  const interrupt = () => forward("SIGINT")
  const terminate = () => forward("SIGTERM")
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", terminate)
  try {
    return await child.exited
  } finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", terminate)
  }
}

try {
  process.exitCode = await launch()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`ralph-next launcher: ${message}\n`)
  process.exitCode = 127
}
