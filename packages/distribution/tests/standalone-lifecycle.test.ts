import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { type CommandContext, executeCli } from "@ralph/commands"
import {
  CurrentInstallPointerSchema,
  type DeferredUninstallRequest,
  DeferredUninstallRequestSchema,
  type DistributionFaultPoint,
  DistributionOperationSchema,
  executeDeferredUninstallCleanup,
  inspectStandaloneInstall,
  installStandalone,
  recoverStandaloneInstall,
  resolveStandaloneInstallLayout,
  rollbackStandalone,
  serializeDistributionControlFile,
  uninstallStandalone,
  updateStandalone,
} from "@ralph/distribution"
import { createTestDirectory, removeTestDirectory } from "../../../tests/helpers/temp-directory"
import {
  AllowlistedFixtureTransport,
  createReleaseFixture,
  type ReleaseFixture,
  sha256,
} from "./release-fixture"

setDefaultTimeout(90_000)

const VERSION = "0.1.0-s12-distribution-contract"
const temporaryDirectories: string[] = []
const uninstallTemporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
  await Promise.all(
    uninstallTemporaryDirectories.splice(0).map(async (path) => {
      const target = resolve(path)
      const temporaryRoot = await realpath(resolve(tmpdir()))
      if (dirname(target) !== temporaryRoot || !basename(target).startsWith("ralph-uninstall-")) {
        throw new Error(`Refusing to clean an unexpected uninstall fixture path: ${target}`)
      }
      await rm(target, { recursive: true, force: true })
    }),
  )
})

async function temporaryDirectory(): Promise<string> {
  const root = await createTestDirectory()
  temporaryDirectories.push(root)
  return root
}

function commandContext(root: string): CommandContext {
  return {
    version: VERSION,
    cwd: root,
    environment: { RALPH_CONFIG_HOME: resolve(root, "isolated-global-config") },
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false
      }
      throw error
    })
}

async function expectMissing(path: string): Promise<void> {
  expect(await exists(path)).toBe(false)
}

async function writeManifest(fixture: ReleaseFixture, manifest: unknown): Promise<void> {
  await writeFile(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

async function installFixture(installRoot: string, fixture: ReleaseFixture): Promise<void> {
  const result = await installStandalone({
    installRoot,
    origin: { kind: "local-artifact", manifestPath: fixture.manifestPath },
    expectedChannel: "nightly",
    expectedVersion: fixture.manifest.version,
  })
  expect(result).toMatchObject({
    action: "install",
    currentVersion: fixture.manifest.version,
    mutationPerformed: true,
    runningBinaryReplaced: false,
    launcherMutation: "install",
  })
}

async function readPointer(installRoot: string) {
  const layout = resolveStandaloneInstallLayout(installRoot)
  return CurrentInstallPointerSchema.parse(
    JSON.parse(await readFile(layout.currentPointer, "utf8")),
  )
}

describe("S12.02 standalone distribution local contract", () => {
  test("real CLI install keeps dry-run mutation-free and commits a receipt-bound local artifact", async () => {
    const root = await temporaryDirectory()
    const fixture = await createReleaseFixture(resolve(root, "release-v1"), {
      version: "1.0.0-dev.1",
    })
    const installRoot = resolve(root, "standalone")
    const context = commandContext(root)

    const preview = await executeCli(
      [
        "install",
        installRoot,
        "--manifest",
        fixture.manifestPath,
        "--channel",
        "nightly",
        "--to-version",
        fixture.manifest.version,
        "--dry-run",
        "--format",
        "json",
      ],
      context,
    )
    expect(preview).toMatchObject({
      exitCode: 0,
      execution: {
        result: {
          command: "install",
          data: {
            action: "install",
            mutationPerformed: false,
            runningBinaryReplaced: false,
            launcherMutation: "install",
          },
        },
      },
    })
    await expectMissing(installRoot)

    const installed = await executeCli(
      [
        "install",
        installRoot,
        "--manifest",
        fixture.manifestPath,
        "--channel",
        "nightly",
        "--to-version",
        fixture.manifest.version,
        "--format",
        "json",
      ],
      context,
    )
    expect(installed).toMatchObject({
      exitCode: 0,
      execution: {
        result: {
          command: "install",
          data: {
            action: "install",
            currentVersion: fixture.manifest.version,
            mutationPerformed: true,
            runningBinaryReplaced: false,
            launcherMutation: "install",
            preserved: ["workspace-state", "global-config", "credentials"],
          },
        },
      },
    })

    const { layout, receipt } = await inspectStandaloneInstall(installRoot)
    const pointer = await readPointer(installRoot)
    expect(pointer).toMatchObject({
      installId: receipt.installId,
      generation: 1,
      version: fixture.manifest.version,
      target: fixture.target,
    })
    expect(receipt).toMatchObject({
      generation: 1,
      currentVersion: fixture.manifest.version,
      currentTarget: fixture.target,
      origin: { kind: "local-artifact", manifestPath: fixture.manifestPath },
      durability: fixture.manifest.supportPolicy.matrix.find(
        (entry) => entry.target === fixture.target,
      )?.capabilities.installControlStateDurability,
    })
    expect(await readFile(layout.launcher)).toEqual(Buffer.from(fixture.launcherBytes))
    expect(await readFile(receipt.currentExecutable)).toEqual(Buffer.from(fixture.engineBytes))
    const installedEngine = receipt.versions[0]?.files.find((file) => file.role === "executable")
    expect(installedEngine).toMatchObject({
      sha256: sha256(fixture.engineBytes),
      sizeBytes: fixture.engineBytes.byteLength,
    })
    expect(receipt.managedPaths).toContain(layout.currentPointer)
    expect(receipt.managedPaths).toContain(layout.launcher)
    expect(receipt.managedPaths).toContain(resolve(layout.root, pointer.receipt))
  })

  test("HTTPS origin uses only an injected allowlisted transport and never requires network", async () => {
    const root = await temporaryDirectory()
    const remoteBaseUrl = "https://updates.local-contract.invalid/release-one/"
    const fixture = await createReleaseFixture(resolve(root, "remote-release"), {
      version: "1.1.0-dev.1",
      remoteBaseUrl,
    })
    if (!fixture.manifestUrl) throw new Error("Remote fixture did not produce a manifest URL")
    const transport = new AllowlistedFixtureTransport(
      new URL(remoteBaseUrl).hostname,
      fixture.bytesByUrl,
    )
    const installRoot = resolve(root, "standalone")

    const result = await installStandalone({
      installRoot,
      origin: { kind: "standalone", manifestUrl: fixture.manifestUrl },
      expectedChannel: "nightly",
      expectedVersion: fixture.manifest.version,
      transport,
    })
    expect(result).toMatchObject({
      action: "install",
      currentVersion: fixture.manifest.version,
      mutationPerformed: true,
    })
    expect(transport.requests.length).toBeGreaterThan(1)
    expect(
      transport.requests.every(
        (url) =>
          new URL(url).protocol === "https:" &&
          new URL(url).hostname === "updates.local-contract.invalid",
      ),
    ).toBe(true)
    expect(await inspectStandaloneInstall(installRoot)).toMatchObject({
      receipt: {
        origin: { kind: "standalone", manifestUrl: fixture.manifestUrl },
        currentVersion: fixture.manifest.version,
      },
    })
  })

  test("size, hash and semantic metadata tamper fail before activation", async () => {
    const root = await temporaryDirectory()
    const cases = [
      {
        name: "size",
        expectedCode: "RALPH_RELEASE_PAYLOAD_SIZE_MISMATCH",
        mutate(manifest: ReleaseFixture["manifest"]) {
          manifest.artifacts[0]!.executable.sizeBytes += 1
        },
      },
      {
        name: "hash",
        expectedCode: "RALPH_RELEASE_PAYLOAD_HASH_MISMATCH",
        mutate(manifest: ReleaseFixture["manifest"]) {
          manifest.artifacts[0]!.executable.sha256 = "0".repeat(64)
        },
      },
    ] as const

    for (const candidate of cases) {
      const fixture = await createReleaseFixture(resolve(root, `release-${candidate.name}`), {
        version: `1.2.${candidate.name === "size" ? "0" : "1"}-dev.1`,
      })
      const manifest = structuredClone(fixture.manifest)
      candidate.mutate(manifest)
      await writeManifest(fixture, manifest)
      const installRoot = resolve(root, `install-${candidate.name}`)
      await expect(
        installStandalone({
          installRoot,
          origin: { kind: "local-artifact", manifestPath: fixture.manifestPath },
        }),
      ).rejects.toMatchObject({ code: candidate.expectedCode })
      const layout = resolveStandaloneInstallLayout(installRoot)
      await expectMissing(layout.currentPointer)
      expect(await readdir(layout.versions)).toEqual([])
    }

    const metadataFixture = await createReleaseFixture(resolve(root, "release-metadata"), {
      version: "1.2.2-dev.1",
      engineMetadataVersion: "9.9.9-dev.1",
    })
    const metadataInstallRoot = resolve(root, "install-metadata")
    await expect(
      installStandalone({
        installRoot: metadataInstallRoot,
        origin: { kind: "local-artifact", manifestPath: metadataFixture.manifestPath },
      }),
    ).rejects.toMatchObject({ code: "RALPH_RELEASE_BUILD_METADATA_MISMATCH" })
    const metadataLayout = resolveStandaloneInstallLayout(metadataInstallRoot)
    await expectMissing(metadataLayout.currentPointer)
    expect(await readdir(metadataLayout.versions)).toEqual([])
  })

  test("check-only, update, downgrade guards and receipt-bound rollback preserve immutable versions", async () => {
    const root = await temporaryDirectory()
    const installRoot = resolve(root, "standalone")
    const first = await createReleaseFixture(resolve(root, "release-v1"), {
      version: "2.0.0-dev.1",
      launcherText: "launcher-v1-running",
      engineText: "engine-v1-running",
    })
    const second = await createReleaseFixture(resolve(root, "release-v2"), {
      version: "2.1.0-dev.1",
      launcherText: "launcher-v2-must-not-replace-running-launcher",
      engineText: "engine-v2",
    })
    await installFixture(installRoot, first)
    const firstState = await inspectStandaloneInstall(installRoot)
    const firstVersion = firstState.receipt.versions[0]!
    const pointerBeforeCheck = await readFile(firstState.layout.currentPointer, "utf8")
    const launcherBeforeUpdate = await readFile(firstState.layout.launcher)

    const check = await updateStandalone({
      installRoot,
      origin: { kind: "local-artifact", manifestPath: second.manifestPath },
      expectedVersion: second.manifest.version,
      expectedChannel: "nightly",
      checkOnly: true,
    })
    expect(check).toMatchObject({
      action: "update",
      currentVersion: first.manifest.version,
      requestedVersion: second.manifest.version,
      available: true,
      evidenceStatus: "built-not-tested",
      evidenceTrust: "declared-unverified",
      authenticity: "unsigned-integrity-verified",
      mutationPerformed: false,
      launcherMutation: "preserve",
    })
    expect(await readFile(firstState.layout.currentPointer, "utf8")).toBe(pointerBeforeCheck)
    await expectMissing(resolve(firstState.layout.versions, second.manifest.version))

    const updated = await updateStandalone({
      installRoot,
      origin: { kind: "local-artifact", manifestPath: second.manifestPath },
      expectedVersion: second.manifest.version,
      expectedChannel: "nightly",
    })
    expect(updated).toMatchObject({
      action: "update",
      previousVersion: first.manifest.version,
      currentVersion: second.manifest.version,
      mutationPerformed: true,
      runningBinaryReplaced: false,
      launcherMutation: "preserve",
    })
    const secondState = await inspectStandaloneInstall(installRoot)
    expect(secondState.receipt).toMatchObject({
      generation: 2,
      previousVersion: first.manifest.version,
      currentVersion: second.manifest.version,
    })
    expect(secondState.receipt.versions.map((entry) => entry.version)).toEqual([
      first.manifest.version,
      second.manifest.version,
    ])
    expect(await readFile(secondState.layout.launcher)).toEqual(launcherBeforeUpdate)
    expect(await readFile(firstVersion.executable)).toEqual(Buffer.from(first.engineBytes))
    expect(await readFile(secondState.receipt.currentExecutable)).toEqual(
      Buffer.from(second.engineBytes),
    )

    const downgrade = await createReleaseFixture(resolve(root, "release-downgrade"), {
      version: "1.9.0-dev.1",
    })
    await expect(
      updateStandalone({
        installRoot,
        origin: { kind: "local-artifact", manifestPath: downgrade.manifestPath },
      }),
    ).rejects.toMatchObject({ code: "RALPH_RELEASE_DOWNGRADE_EXPLICIT_REQUIRED" })

    const incompatible = await createReleaseFixture(resolve(root, "release-incompatible"), {
      version: "1.8.0-dev.1",
      minimumWorkspaceSchema: 2,
      maximumWorkspaceSchema: 2,
    })
    await expect(
      updateStandalone({
        installRoot,
        origin: { kind: "local-artifact", manifestPath: incompatible.manifestPath },
        allowDowngrade: true,
        workspaceSchema: 1,
      }),
    ).rejects.toMatchObject({ code: "RALPH_RELEASE_WORKSPACE_SCHEMA_INCOMPATIBLE" })

    await writeFile(firstVersion.executable, "tampered-old-engine")
    await expect(
      rollbackStandalone({ installRoot, version: first.manifest.version }),
    ).rejects.toMatchObject({ code: "RALPH_INSTALL_FILE_TAMPERED" })
    expect((await readPointer(installRoot)).version).toBe(second.manifest.version)
    await writeFile(firstVersion.executable, first.engineBytes)

    const rolledBack = await rollbackStandalone({
      installRoot,
      version: first.manifest.version,
    })
    expect(rolledBack).toMatchObject({
      action: "rollback",
      previousVersion: second.manifest.version,
      currentVersion: first.manifest.version,
      mutationPerformed: true,
      runningBinaryReplaced: false,
      launcherMutation: "none",
    })
    const rolledBackState = await inspectStandaloneInstall(installRoot)
    expect(rolledBackState.receipt).toMatchObject({
      generation: 3,
      previousVersion: second.manifest.version,
      currentVersion: first.manifest.version,
    })
  })

  test("launcher failure and incompatible schema remain fail-closed with honest repair state", async () => {
    const root = await temporaryDirectory()
    const installRoot = resolve(root, "standalone")
    const first = await createReleaseFixture(resolve(root, "release-v1"), {
      version: "3.0.0-dev.1",
    })
    const incompatible = await createReleaseFixture(resolve(root, "release-v2"), {
      version: "3.1.0-dev.1",
      minimumLauncherSchema: 2,
      maximumLauncherSchema: 2,
    })
    await installFixture(installRoot, first)
    const before = await inspectStandaloneInstall(installRoot)
    const pointerBefore = await readFile(before.layout.currentPointer, "utf8")

    await writeFile(before.layout.launcher, "tampered-launcher")
    await expect(
      updateStandalone({
        installRoot,
        origin: { kind: "local-artifact", manifestPath: incompatible.manifestPath },
      }),
    ).rejects.toMatchObject({ code: "RALPH_INSTALL_FILE_TAMPERED" })
    await writeFile(before.layout.launcher, first.launcherBytes)

    await expect(
      updateStandalone({
        installRoot,
        origin: { kind: "local-artifact", manifestPath: incompatible.manifestPath },
      }),
    ).rejects.toMatchObject({ code: "RALPH_INSTALL_LAUNCHER_REPAIR_REQUIRED" })
    expect(await readFile(before.layout.currentPointer, "utf8")).toBe(pointerBefore)
    await expectMissing(resolve(before.layout.versions, incompatible.manifest.version))

    const reported = await recoverStandaloneInstall(installRoot)
    expect(reported).toEqual([
      expect.objectContaining({
        action: "update",
        previousStatus: "repair-required",
        disposition: "repair-required",
      }),
    ])
    expect((await inspectStandaloneInstall(installRoot)).receipt.currentVersion).toBe(
      first.manifest.version,
    )

    const cleaned = await recoverStandaloneInstall(installRoot, {
      cleanupRepairRequired: true,
    })
    expect(cleaned).toEqual([
      expect.objectContaining({
        action: "update",
        previousStatus: "repair-required",
        disposition: "cleaned",
      }),
    ])
    expect((await inspectStandaloneInstall(installRoot)).receipt.currentVersion).toBe(
      first.manifest.version,
    )
  })

  test("journal recovery reconciles planned, staged, verified and activated update crashes", async () => {
    const root = await temporaryDirectory()
    const points: readonly DistributionFaultPoint[] = ["planned", "staged", "verified", "activated"]

    for (const [index, point] of points.entries()) {
      const caseRoot = resolve(root, `case-${point}`)
      const installRoot = resolve(caseRoot, "standalone")
      const first = await createReleaseFixture(resolve(caseRoot, "release-v1"), {
        version: `4.${index}.0-dev.1`,
      })
      const second = await createReleaseFixture(resolve(caseRoot, "release-v2"), {
        version: `4.${index}.1-dev.1`,
      })
      await installFixture(installRoot, first)
      const observed: DistributionFaultPoint[] = []

      await expect(
        updateStandalone({
          installRoot,
          origin: { kind: "local-artifact", manifestPath: second.manifestPath },
          fault(context) {
            observed.push(context.point)
            if (context.point === point) throw new Error(`crash-after-${point}`)
          },
        }),
      ).rejects.toThrow(`Injected distribution interruption after ${point}`)
      expect(observed.at(-1)).toBe(point)

      const recovered = await recoverStandaloneInstall(installRoot)
      expect(recovered).toEqual([
        expect.objectContaining({
          action: "update",
          previousStatus: point,
          disposition: point === "activated" ? "finalized" : "cleaned",
        }),
      ])
      const state = await inspectStandaloneInstall(installRoot)
      expect(state.receipt.currentVersion).toBe(
        point === "activated" ? second.manifest.version : first.manifest.version,
      )
      expect(await readdir(state.layout.staging)).toEqual([])
    }
  })

  test("uninstall preview, scheduler handoff and external helper remove only receipt-owned paths", async () => {
    const root = await temporaryDirectory()
    const installRoot = resolve(root, "standalone")
    const workspace = resolve(root, "workspace")
    const globalConfig = resolve(root, "global-config", "config.yaml")
    const credentials = resolve(root, "credential-store", "credential.ref")
    const classicRalph = resolve(root, "ralph-classic.exe")
    const sentinel = resolve(root, "keep-me.txt")
    await mkdir(resolve(workspace, ".ralph"), { recursive: true })
    await mkdir(dirname(globalConfig), { recursive: true })
    await mkdir(dirname(credentials), { recursive: true })
    await writeFile(resolve(workspace, ".ralph", "state.db"), "workspace-state")
    await writeFile(globalConfig, "language: pt-BR\n")
    await writeFile(credentials, "credential-reference-only")
    await writeFile(classicRalph, "classic-ralph")
    await writeFile(sentinel, "outside-install-root")

    const fixture = await createReleaseFixture(resolve(root, "release-v1"), {
      version: "5.0.0-dev.1",
    })
    await installFixture(installRoot, fixture)
    const context = commandContext(root)
    const preview = await executeCli(
      ["uninstall", installRoot, "--dry-run", "--format", "json"],
      context,
    )
    expect(preview).toMatchObject({
      exitCode: 0,
      execution: {
        result: {
          command: "uninstall",
          data: {
            action: "uninstall",
            currentVersion: fixture.manifest.version,
            mutationPerformed: false,
            runningBinaryReplaced: false,
          },
        },
      },
    })
    expect(await exists(installRoot)).toBe(true)

    let scheduledRequest: DeferredUninstallRequest | undefined
    const scheduledDirectory = await realpath(
      await mkdtemp(join(await realpath(resolve(tmpdir())), "ralph-uninstall-")),
    )
    uninstallTemporaryDirectories.push(scheduledDirectory)
    const scheduled = await uninstallStandalone({
      installRoot,
      deferredCleanup: {
        async schedule(request) {
          scheduledRequest = request
          const requestPath = resolve(scheduledDirectory, "cleanup-request.json")
          await writeFile(requestPath, serializeDistributionControlFile(request))
          return { helperPath: process.execPath, requestPath }
        },
      },
    })
    expect(scheduled).toMatchObject({
      action: "uninstall",
      cleanupDisposition: "scheduled",
      mutationPerformed: true,
      runningBinaryReplaced: false,
      preserved: ["workspace-state", "global-config", "credentials"],
    })
    expect(scheduledRequest).toMatchObject({
      installRoot,
      currentVersion: fixture.manifest.version,
      waitForPids: expect.arrayContaining([process.pid]),
    })
    expect(await exists(installRoot)).toBe(true)

    const deadProcess = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    })
    await deadProcess.exited
    const state = await inspectStandaloneInstall(installRoot)
    const pointer = await readPointer(installRoot)
    const helperDirectory = await realpath(
      await mkdtemp(join(await realpath(resolve(tmpdir())), "ralph-uninstall-")),
    )
    uninstallTemporaryDirectories.push(helperDirectory)
    const request = DeferredUninstallRequestSchema.parse({
      schemaVersion: 1,
      requestId: randomUUID(),
      handoffToken: randomUUID(),
      installRoot,
      installId: state.receipt.installId,
      generation: state.receipt.generation,
      receiptPath: resolve(installRoot, pointer.receipt),
      receiptSha256: pointer.receiptSha256,
      currentVersion: state.receipt.currentVersion,
      target: state.receipt.currentTarget,
      waitForPids: [deadProcess.pid],
      createdByPid: deadProcess.pid,
      createdAt: "2026-07-19T00:00:00.000Z",
      maximumWaitMilliseconds: 60_000,
    })
    const requestPath = resolve(helperDirectory, "cleanup-request.json")
    const requestBytes = new TextEncoder().encode(serializeDistributionControlFile(request))
    await writeFile(requestPath, requestBytes)
    const removed = await executeDeferredUninstallCleanup({
      requestPath,
      expectedSha256: createHash("sha256").update(requestBytes).digest("hex"),
      handoffToken: request.handoffToken,
    })
    expect(removed).toMatchObject({
      action: "uninstall",
      previousVersion: fixture.manifest.version,
      cleanupDisposition: "completed",
      mutationPerformed: true,
      runningBinaryReplaced: false,
      preserved: ["workspace-state", "global-config", "credentials"],
    })
    await expectMissing(installRoot)
    expect(await readFile(resolve(workspace, ".ralph", "state.db"), "utf8")).toBe("workspace-state")
    expect(await readFile(globalConfig, "utf8")).toBe("language: pt-BR\n")
    expect(await readFile(credentials, "utf8")).toBe("credential-reference-only")
    expect(await readFile(classicRalph, "utf8")).toBe("classic-ralph")
    expect(await readFile(sentinel, "utf8")).toBe("outside-install-root")
  })

  test("operation journals remain schema-valid at every injected recovery boundary", async () => {
    const root = await temporaryDirectory()
    const installRoot = resolve(root, "standalone")
    const first = await createReleaseFixture(resolve(root, "release-v1"), {
      version: "6.0.0-dev.1",
    })
    const second = await createReleaseFixture(resolve(root, "release-v2"), {
      version: "6.1.0-dev.1",
    })
    await installFixture(installRoot, first)

    await expect(
      updateStandalone({
        installRoot,
        origin: { kind: "local-artifact", manifestPath: second.manifestPath },
        fault(context) {
          if (context.point === "verified") throw new Error("inspect-journal")
        },
      }),
    ).rejects.toThrow("Injected distribution interruption after verified")
    const layout = resolveStandaloneInstallLayout(installRoot)
    const operationDirectories = await readdir(layout.staging)
    expect(operationDirectories).toHaveLength(1)
    const operation = DistributionOperationSchema.parse(
      JSON.parse(
        await readFile(resolve(layout.staging, operationDirectories[0]!, "operation.json"), "utf8"),
      ),
    )
    expect(operation).toMatchObject({
      action: "update",
      status: "verified",
      installId: (await inspectStandaloneInstall(installRoot)).receipt.installId,
      previousVersion: first.manifest.version,
      requestedVersion: second.manifest.version,
      target: second.target,
      launcherMutation: "preserve",
    })
    expect(operation.stagedPaths.length).toBeGreaterThan(2)
    await recoverStandaloneInstall(installRoot)
  })
})
