import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import packageJson from "../package.json" with { type: "json" }
import { nativeTarget, parseBuildTargets, type ReleaseTarget, sha256File } from "./build-artifact"
import { sourceFingerprint } from "./source-fingerprint"

const OPENTUI_NATIVE_PACKAGES = [
  "@opentui/core-darwin-x64",
  "@opentui/core-darwin-arm64",
  "@opentui/core-linux-x64",
  "@opentui/core-linux-arm64",
  "@opentui/core-linux-x64-musl",
  "@opentui/core-linux-arm64-musl",
  "@opentui/core-win32-x64",
  "@opentui/core-win32-arm64",
] as const

function openTuiPackageFor(target: ReleaseTarget): (typeof OPENTUI_NATIVE_PACKAGES)[number] {
  if (target === "bun-windows-x64-baseline") return "@opentui/core-win32-x64"
  if (target === "bun-windows-arm64") return "@opentui/core-win32-arm64"
  if (target === "bun-linux-x64-baseline") return "@opentui/core-linux-x64"
  if (target === "bun-linux-arm64") return "@opentui/core-linux-arm64"
  if (target === "bun-darwin-x64") return "@opentui/core-darwin-x64"
  return "@opentui/core-darwin-arm64"
}

function externalOpenTuiPackages(target: ReleaseTarget): string[] {
  const included = openTuiPackageFor(target)
  return OPENTUI_NATIVE_PACKAGES.filter((packageName) => packageName !== included).map(
    (packageName) => `--external=${packageName}`,
  )
}

async function run(command: string[]): Promise<void> {
  const processHandle = Bun.spawn(command, {
    cwd: resolve(import.meta.dir, ".."),
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
    windowsHide: true,
  })
  const exitCode = await processHandle.exited
  if (exitCode !== 0) throw new Error(`Build command failed (${exitCode}): ${command.join(" ")}`)
}

async function buildBundle(projectRoot: string): Promise<void> {
  await mkdir(join(projectRoot, "dist"), { recursive: true })
  const output = join(projectRoot, "dist", "ralph-next.js")
  await run([
    process.execPath,
    "build",
    "apps/ralph-cli/src/main.ts",
    "--target=bun",
    "--packages=bundle",
    "--allow-unresolved=<empty>",
    ...externalOpenTuiPackages(nativeTarget()),
    "--sourcemap=external",
    "--outdir=dist",
    "--entry-naming=ralph-next.js",
  ])
  const fingerprint = await sourceFingerprint(projectRoot)
  await Bun.write(
    join(projectRoot, "dist", "bundle-build-metadata.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        product: "ralph-next-bundle",
        target: "bun",
        status: "built-not-tested",
        version: packageJson.version,
        bunVersion: Bun.version,
        bunRevision: Bun.revision,
        artifact: output.slice(projectRoot.length + 1).replaceAll("\\", "/"),
        sha256: await sha256File(output),
        sourceSha256: fingerprint,
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  )
}

async function buildStandalone(projectRoot: string, target: ReleaseTarget): Promise<void> {
  const extension = target.startsWith("bun-windows-") ? ".exe" : ""
  const directory = join(projectRoot, "dist", "standalone", target)
  const output = join(directory, `ralph-next${extension}`)
  const launcherOutput = join(directory, `ralph-next-launcher${extension}`)
  await mkdir(directory, { recursive: true })
  await run([
    process.execPath,
    "build",
    "apps/ralph-cli/src/main.ts",
    "--compile",
    `--target=${target}`,
    "--packages=bundle",
    "--allow-unresolved=<empty>",
    ...externalOpenTuiPackages(target),
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--no-compile-autoload-package-json",
    "--no-compile-autoload-tsconfig",
    `--outfile=${output}`,
  ])
  await run([
    process.execPath,
    "build",
    "apps/ralph-launcher/src/main.ts",
    "--compile",
    `--target=${target}`,
    "--packages=bundle",
    "--reject-unresolved",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--no-compile-autoload-package-json",
    "--no-compile-autoload-tsconfig",
    `--outfile=${launcherOutput}`,
  ])
  const fingerprint = await sourceFingerprint(projectRoot)
  const metadata = {
    schemaVersion: 1,
    target,
    status: "built-not-tested",
    version: packageJson.version,
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    artifact: output.slice(projectRoot.length + 1).replaceAll("\\", "/"),
    sha256: await sha256File(output),
    sourceSha256: fingerprint,
    builtAt: new Date().toISOString(),
  }
  await Bun.write(join(directory, "build-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`)
  const launcherMetadata = {
    schemaVersion: 1,
    product: "ralph-next-launcher",
    target,
    status: "built-not-tested",
    version: packageJson.version,
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    artifact: launcherOutput.slice(projectRoot.length + 1).replaceAll("\\", "/"),
    sha256: await sha256File(launcherOutput),
    sourceSha256: fingerprint,
    builtAt: new Date().toISOString(),
  }
  await Bun.write(
    join(directory, "launcher-build-metadata.json"),
    `${JSON.stringify(launcherMetadata, null, 2)}\n`,
  )
}

const projectRoot = resolve(import.meta.dir, "..")
const targets = parseBuildTargets(process.argv.slice(2))
await buildBundle(projectRoot)
for (const target of targets) await buildStandalone(projectRoot, target)

console.log(`Built bundle and ${targets.length} standalone target(s): ${targets.join(", ")}`)
