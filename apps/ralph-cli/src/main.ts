#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { chmod, copyFile, lstat, mkdtemp, open, readFile, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { type CommandContext, executeCli, type RunUiCommandService, runCli } from "@ralph/commands"
import {
  DeferredUninstallRequestSchema,
  type DeferredUninstallScheduler,
  executeDeferredUninstallCleanup,
  InstallOriginSchema,
  serializeDistributionControlFile,
} from "@ralph/distribution"
import { createSandboxProcessPort, discoverSandboxCapability } from "@ralph/orchestration"
import packageJson from "../../../package.json" with { type: "json" }
import { createCommandShutdownLifecycle } from "./command-shutdown"
import { createConfigEditorCommandService } from "./config-editor"
import { loadDistributionSignatureComposition } from "./distribution-signature"
import { runDurableProcessOwnerMain } from "./durable-process-owner"
import { createPullRequestPortFromEnvironment } from "./pull-request-port"
import { createS04Services } from "./s04-services"
import { createS05Services } from "./s05-services"
import { createS07CommandServices } from "./s07-services"
import { createTerminalPermissionPrompt } from "./terminal-permission-prompt"
import type { TuiRoleProfileConfigure } from "./tui-services"
import {
  createWorkerChildRunSession,
  createWorkerGateRegistry,
  createWorkerGitProcessSupervisor,
  createWorkerIsolatedExecutionServices,
  createWorkerIsolatedToolPort,
} from "./worker-composition"
import { runWorkerMain } from "./worker-main"

const INTERNAL_UNINSTALL_CLEANUP = "--ralph-internal-uninstall-cleanup"
const DISTRIBUTION_ORIGIN_SYMBOL = Symbol.for("ralph.distribution-origin")

async function commandDistributionOrigin(): Promise<CommandContext["distributionOrigin"]> {
  const shared = globalThis as typeof globalThis & Record<symbol, unknown>
  const packaged = InstallOriginSchema.safeParse(shared[DISTRIBUTION_ORIGIN_SYMBOL])
  if (packaged.success && packaged.data.kind === "npm") return packaged.data

  // A dev origin requires the actual source entrypoint plus checkout
  // sentinels. A loose bundle hosted by Bun and a compiled engine invoked
  // without its launcher remain unmanaged/unknown and cannot receive a Git
  // diagnostic merely because of their runtime executable.
  try {
    const sourceRoot = resolve(import.meta.dir, "../../..")
    const sourceEntrypoint = resolve(sourceRoot, "apps", "ralph-cli", "src", "main.ts")
    const sourceManifest = resolve(sourceRoot, "package.json")
    const sourceLock = resolve(sourceRoot, "bun.lock")
    const sourceGit = resolve(sourceRoot, ".git")
    const [currentEntrypoint, expectedEntrypoint, manifestInfo, lockInfo, gitInfo] =
      await Promise.all([
        realpath(fileURLToPath(import.meta.url)),
        realpath(sourceEntrypoint),
        lstat(sourceManifest),
        lstat(sourceLock),
        lstat(sourceGit),
      ])
    if (
      currentEntrypoint !== expectedEntrypoint ||
      !manifestInfo.isFile() ||
      manifestInfo.isSymbolicLink() ||
      manifestInfo.size < 2 ||
      manifestInfo.size > 64 * 1024 ||
      !lockInfo.isFile() ||
      lockInfo.isSymbolicLink() ||
      gitInfo.isSymbolicLink() ||
      (!gitInfo.isDirectory() && !gitInfo.isFile()) ||
      (gitInfo.isFile() && (gitInfo.size < 1 || gitInfo.size > 64 * 1024))
    ) {
      return undefined
    }
    const manifest: unknown = JSON.parse(await readFile(sourceManifest, "utf8"))
    if (
      typeof manifest === "object" &&
      manifest !== null &&
      "name" in manifest &&
      manifest.name === packageJson.name &&
      "version" in manifest &&
      manifest.version === packageJson.version &&
      "private" in manifest &&
      manifest.private === true
    ) {
      return { kind: "dev-checkout" }
    }
  } catch {
    // Missing, bundled or unreadable sentinels mean unknown origin. Update
    // remains fail-closed and asks for an explicit standalone root.
  }
  return undefined
}

function inside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate)
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

function launcherPid(environment: NodeJS.ProcessEnv): number | undefined {
  const raw = environment.RALPH_STANDALONE_LAUNCHER_PID
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function deferredUninstallScheduler(): DeferredUninstallScheduler {
  return {
    async schedule(rawRequest) {
      const request = DeferredUninstallRequestSchema.parse(rawRequest)
      const canonicalTemp = await realpath(resolve(tmpdir()))
      const operationRoot = await mkdtemp(join(canonicalTemp, "ralph-uninstall-"))
      const installRoot = resolve(request.installRoot)
      if (operationRoot === installRoot || inside(installRoot, operationRoot)) {
        throw new Error("OS temp directory is not external to the requested install root")
      }
      const requestPath = join(operationRoot, "cleanup-request.json")
      const requestBytes = new TextEncoder().encode(serializeDistributionControlFile(request))
      const requestSha256 = createHash("sha256").update(requestBytes).digest("hex")
      const requestHandle = await open(requestPath, "wx", 0o600)
      try {
        await requestHandle.writeFile(requestBytes)
        await requestHandle.sync()
      } finally {
        await requestHandle.close()
      }

      const executable = await realpath(process.execPath)
      const launchedRoot = process.env.RALPH_STANDALONE_INSTALL_ROOT
        ? resolve(process.env.RALPH_STANDALONE_INSTALL_ROOT)
        : undefined
      const isInstalledEngine = launchedRoot === installRoot && inside(installRoot, executable)
      let helperPath: string
      let command: string[]
      if (isInstalledEngine) {
        helperPath = join(operationRoot, `ralph-uninstall-helper${extname(executable)}`)
        await copyFile(executable, helperPath)
        if (process.platform !== "win32") await chmod(helperPath, 0o700)
        command = [
          helperPath,
          INTERNAL_UNINSTALL_CLEANUP,
          requestPath,
          requestSha256,
          request.handoffToken,
        ]
      } else {
        if (inside(installRoot, executable)) {
          throw new Error(
            "Deferred uninstall cannot execute its helper from inside the install root",
          )
        }
        helperPath = executable
        command = [
          executable,
          import.meta.path,
          INTERNAL_UNINSTALL_CLEANUP,
          requestPath,
          requestSha256,
          request.handoffToken,
        ]
      }
      const helper = Bun.spawn(command, {
        cwd: canonicalTemp,
        env: process.env,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
        windowsHide: true,
      })
      helper.unref()
      return { helperPath, requestPath }
    },
  }
}

async function runInternalUninstallCleanup(): Promise<boolean> {
  const index = process.argv.indexOf(INTERNAL_UNINSTALL_CLEANUP)
  if (index < 0) return false
  const trailing = process.argv.slice(index + 1)
  if (trailing.length !== 3 || trailing.some((value) => value.length === 0)) {
    throw new Error("Invalid internal uninstall cleanup handoff")
  }
  await executeDeferredUninstallCleanup({
    requestPath: trailing[0]!,
    expectedSha256: trailing[1]!,
    handoffToken: trailing[2]!,
  })
  return true
}

async function runCommandMain(): Promise<Awaited<ReturnType<typeof runCli>>> {
  const services = createS04Services({ environment: process.env })
  const permissionPrompt = createTerminalPermissionPrompt({
    input: process.stdin,
    output: process.stderr,
  })
  const workerToolPort = createWorkerIsolatedToolPort({ prompt: permissionPrompt })
  const baseExecution = createS05Services({
    s04: services,
    environment: process.env,
    toolPort: workerToolPort,
  })
  const execution = await createWorkerIsolatedExecutionServices({
    base: baseExecution,
    environment: process.env,
  })
  const runLifecycle = createS07CommandServices()
  const sandboxProcessPort = createSandboxProcessPort()
  const configEditor = createConfigEditorCommandService(process.env)
  const deferredCleanup = deferredUninstallScheduler()
  const parentLauncherPid = launcherPid(process.env)
  const distributionOrigin = await commandDistributionOrigin()
  let commandContext: CommandContext | undefined
  const configureTuiProfile: TuiRoleProfileConfigure = async (request) => {
    const context = commandContext
    if (!context) throw new Error("Command context is unavailable for TUI profile configuration")
    const argv = [
      "profiles",
      "configure",
      request.profileId,
      "--workspace",
      request.workspaceRoot,
      ...(request.setDefault ? ["--set-default"] : []),
      "--format",
      "json",
    ]
    const profileExecution = await executeCli(argv, {
      ...context,
      profileForm: async (formRequest) => {
        if (formRequest.profileId !== request.profileId) {
          throw new Error("TUI profile form identity changed before command-owned persistence")
        }
        return {
          scope: request.scope,
          profile: request.profile,
          profileLayer: request.profileLayer,
          ...(request.setDefault ? { setDefault: true } : {}),
          expectedTargetSha256: request.expectedTargetSha256,
          expectedPeerSha256: request.expectedPeerSha256,
        }
      },
    })
    if (!profileExecution.execution.result.ok) {
      const diagnostic = profileExecution.execution.result.diagnostics[0]
      throw new Error(
        diagnostic
          ? `${diagnostic.code}: ${diagnostic.message}${diagnostic.hint ? ` (${diagnostic.hint})` : ""}`
          : "Role profile configuration failed",
      )
    }
  }
  const shutdown = createCommandShutdownLifecycle()
  const pullRequests = createPullRequestPortFromEnvironment(process.env)
  // The Windows ARM64 build of Bun 1.3.14 has no bun:ffi/TinyCC, while the
  // OpenTUI native renderer requires it. Keep the command engine available and
  // let `--ui auto` select its headless presentation by omitting only the TUI
  // adapter on that exact runtime. Explicit `--ui tui` still fails closed with
  // RALPH_TUI_UNAVAILABLE instead of reaching an opaque dlopen crash.
  const interactiveTuiAvailable = !(process.platform === "win32" && process.arch === "arm64")
  const runUi: RunUiCommandService | undefined = interactiveTuiAvailable
    ? {
        async prepare(request) {
          const { createTuiServices } = await import("./tui-services")
          const tui = createTuiServices({
            runControl: runLifecycle.runControl,
            interrupt: shutdown.interrupt,
            resolveModelCatalog: services.resolveModelCatalog,
            credentials: services.credentials,
            configureProfile: configureTuiProfile,
          })
          if (!tui.prepare) throw new Error("TUI preparation service is unavailable")
          return tui.prepare(request)
        },
        async attach(request) {
          const { createTuiServices } = await import("./tui-services")
          return createTuiServices({
            runControl: runLifecycle.runControl,
            interrupt: shutdown.interrupt,
            resolveModelCatalog: services.resolveModelCatalog,
            credentials: services.credentials,
            configureProfile: configureTuiProfile,
          }).attach(request)
        },
      }
    : undefined
  try {
    commandContext = {
      version: packageJson.version,
      cwd: process.cwd(),
      environment: process.env,
      interactive:
        process.stdin.isTTY === true &&
        process.stdout.isTTY === true &&
        process.stderr.isTTY === true,
      signal: shutdown.signal,
      resolveModelCatalog: services.resolveModelCatalog,
      credentials: services.credentials,
      profileForm: services.profileForm,
      ...(configEditor ? { configEditor } : {}),
      modelSmoke: services.modelSmoke,
      resolveBackend: execution.resolveBackend,
      resolveJudge: execution.resolveJudge,
      toolPort: execution.toolPort,
      gateRegistryFactory: createWorkerGateRegistry,
      gitProcessSupervisorFactory: createWorkerGitProcessSupervisor,
      childRunWorkerSessionFactory: createWorkerChildRunSession,
      ...(pullRequests ? { pullRequests } : {}),
      ...(runUi ? { runUi } : {}),
      runControl: runLifecycle.runControl,
      contextControl: runLifecycle.contextControl,
      sandboxCapabilities: {
        discover: ({ backend, signal }) =>
          discoverSandboxCapability(sandboxProcessPort, backend, signal),
      },
      supervisorControl: runLifecycle.supervisorControl,
      resolveDistributionSignature: () => loadDistributionSignatureComposition(process.env),
      ...(distributionOrigin ? { distributionOrigin } : {}),
      distributionUninstall: {
        deferredCleanup,
        waitForPids: [process.pid, ...(parentLauncherPid ? [parentLauncherPid] : [])],
      },
    }
    return await runCli(process.argv.slice(2), commandContext)
  } finally {
    await shutdown.close()
  }
}

process.exitCode = (await runInternalUninstallCleanup())
  ? 0
  : process.env.RALPH_DURABLE_PROCESS_OWNER === "1"
    ? await runDurableProcessOwnerMain()
    : process.env.RALPH_WORKER === "1"
      ? await runWorkerMain()
      : await runCommandMain()
