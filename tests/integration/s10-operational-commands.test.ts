import { afterEach, describe, expect, test } from "bun:test"
import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  type CommandContext,
  type DistributionCommandService,
  executeCli,
  runCli,
} from "@ralph-next/commands"
import { initializeWorkspace, workspaceLayout } from "@ralph-next/persistence"
import type { OutputWriters } from "@ralph-next/telemetry"
import { type ScriptedExecution, ScriptedExecutionBackend } from "@ralph-next/test-kit"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const VERSION = "0.1.0-s10-operational-test"
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

async function temporaryDirectory(): Promise<string> {
  const root = await createTestDirectory()
  temporaryDirectories.push(root)
  return root
}

async function initializedWorkspace(): Promise<string> {
  const root = await temporaryDirectory()
  await writeFile(resolve(root, "PRD.md"), "# Operational command fixture\n")
  await initializeWorkspace(root, VERSION)
  return root
}

function commandContext(root: string, extra: Partial<CommandContext> = {}): CommandContext {
  return {
    version: VERSION,
    cwd: root,
    environment: { RALPH_CONFIG_HOME: resolve(root, "isolated-global-config") },
    ...extra,
  }
}

function captureWriters(): {
  writers: OutputWriters
  stdout: () => string
  stderr: () => string
} {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    writers: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  }
}

async function expectMissing(path: string): Promise<void> {
  await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
}

async function contextFixture(): Promise<{
  root: string
  context: CommandContext
  runId: string
}> {
  const root = await temporaryDirectory()
  await cp(resolve("tests", "fixtures", "execution", "single-pass"), root, { recursive: true })

  // This command contract needs persisted model-call context, not a nested verification process.
  const prdPath = resolve(root, "PRD.md")
  const prd = (await readFile(prdPath, "utf8"))
    .replaceAll("evidence_mode: criteria", "evidence_mode: change-only")
    .replaceAll("Modo de evidência: criteria", "Modo de evidência: change-only")
    .replace(/ {2}- Verificação:\r?\n {4}- command: \{.*\}\r?\n/u, "")
  await writeFile(prdPath, prd)
  await initializeWorkspace(root, VERSION)

  const script = JSON.parse(
    await readFile(resolve(root, "backend.json"), "utf8"),
  ) as ScriptedExecution[]
  const backend = new ScriptedExecutionBackend(script)
  const context = commandContext(root, {
    resolveBackend: (profile) => (profile === "fixture-executor" ? backend : undefined),
  })
  const executed = await executeCli(
    ["once", "--workspace", root, "--prd", "PRD.md", "--format", "json"],
    context,
  )
  expect(executed.exitCode).toBe(0)
  const runId = executed.execution.result.runId
  if (!runId) throw new Error("Context fixture did not persist a run")
  return { root, context, runId }
}

async function git(root: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr}`)
}

describe("S10.06 public operational command contracts", () => {
  test("clean previews without mutation, requires force and refuses unidentified state", async () => {
    const root = await initializedWorkspace()
    const context = commandContext(root)
    const statePath = workspaceLayout(root).ralph
    const prdBefore = await readFile(resolve(root, "PRD.md"), "utf8")

    const preview = await executeCli(
      ["clean", "--workspace", root, "--dry-run", "--format", "json"],
      context,
    )
    expect(preview).toMatchObject({
      exitCode: 0,
      execution: {
        result: {
          ok: true,
          command: "clean",
          data: { dryRun: true, removed: false, activeRunIds: [] },
        },
      },
    })
    expect(await readFile(resolve(statePath, "workspace.json"), "utf8")).not.toBe("")

    const human = captureWriters()
    expect(await runCli(["clean", "--workspace", root, "--dry-run"], context, human.writers)).toBe(
      0,
    )
    expect(human.stdout()).toContain("Clean preview")
    expect(human.stderr()).toBe("")

    const unconfirmed = await executeCli(
      ["clean", "--workspace", root, "--format", "json"],
      context,
    )
    expect(unconfirmed).toMatchObject({
      exitCode: 10,
      execution: { result: { diagnostics: [{ code: "RALPH_CLEAN_FORCE_REQUIRED" }] } },
    })
    expect(await readFile(resolve(statePath, "workspace.json"), "utf8")).not.toBe("")

    const removed = await executeCli(
      ["clean", "--workspace", root, "--force", "--format", "json"],
      context,
    )
    expect(removed).toMatchObject({
      exitCode: 0,
      execution: { result: { data: { dryRun: false, removed: true, recoverable: false } } },
    })
    await expectMissing(resolve(statePath, "workspace.json"))
    expect(await readFile(resolve(root, "PRD.md"), "utf8")).toBe(prdBefore)

    const legacyRoot = await temporaryDirectory()
    await mkdir(resolve(legacyRoot, ".ralph"), { recursive: true })
    const legacyMarker = resolve(legacyRoot, ".ralph", "legacy-state.txt")
    await writeFile(legacyMarker, "legacy\n")
    const refused = await executeCli(
      ["clean", "--workspace", legacyRoot, "--force", "--format", "json"],
      commandContext(legacyRoot),
    )
    expect(refused).toMatchObject({
      exitCode: 7,
      execution: {
        result: { diagnostics: [{ code: "RALPH_FOREIGN_STATE_EXISTS" }] },
      },
    })
    expect(await readFile(legacyMarker, "utf8")).toBe("legacy\n")
  })

  test("rules list/add are human-readable and idempotent; clear is force-gated", async () => {
    const root = await initializedWorkspace()
    const context = commandContext(root)
    const rule = "Keep each delivery vertically testable."

    const empty = await executeCli(
      ["rules", "list", "--workspace", root, "--format", "json"],
      context,
    )
    expect(empty).toMatchObject({
      exitCode: 0,
      execution: { result: { command: "rules.list", data: { count: 0, rules: [] } } },
    })

    const added = await executeCli(
      ["rules", "add", rule, "--workspace", root, "--format", "json"],
      context,
    )
    expect(added).toMatchObject({
      exitCode: 0,
      execution: { result: { data: { changed: true, rule, count: 1 } } },
    })
    const repeated = await executeCli(
      ["rules", "add", rule, "--workspace", root, "--format", "json"],
      context,
    )
    expect(repeated).toMatchObject({
      exitCode: 0,
      execution: { result: { data: { changed: false, rule, count: 1 } } },
    })

    const human = captureWriters()
    expect(await runCli(["rules", "list", "--workspace", root], context, human.writers)).toBe(0)
    expect(human.stdout()).toContain(`1. ${rule}`)
    expect(human.stderr()).toBe("")

    const refused = await executeCli(
      ["rules", "clear", "--workspace", root, "--format", "json"],
      context,
    )
    expect(refused).toMatchObject({
      exitCode: 10,
      execution: {
        result: { diagnostics: [{ code: "RALPH_RULES_CLEAR_CONFIRMATION_REQUIRED" }] },
      },
    })
    const stillPresent = await executeCli(
      ["rules", "list", "--workspace", root, "--format", "json"],
      context,
    )
    expect(stillPresent.execution.result.data).toMatchObject({ count: 1, rules: [rule] })

    const cleared = await executeCli(
      ["rules", "clear", "--workspace", root, "--force", "--format", "json"],
      context,
    )
    expect(cleared).toMatchObject({
      exitCode: 0,
      execution: { result: { data: { cleared: 1 } } },
    })
    expect(await readFile(resolve(root, ".ralph", "rules.md"), "utf8")).toContain(
      "# Ralph workspace rules",
    )
  })

  test("context inspect/export stay metadata-only and rotation crosses only its control port", async () => {
    const { root, context, runId } = await contextFixture()

    const inspection = await executeCli(
      ["context", "inspect", "--workspace", root, "--run-id", runId, "--format", "json"],
      context,
    )
    expect(inspection.exitCode).toBe(0)
    const inspectionData = inspection.execution.result.data as {
      exportPolicy: string
      contexts: Array<{ path: string; integrity: string; sensitiveContentIncluded: boolean }>
    }
    expect(inspectionData.exportPolicy).toBe("metadata-only")
    expect(inspectionData.contexts.length).toBeGreaterThan(0)
    expect(inspectionData.contexts.every((item) => item.integrity === "verified")).toBe(true)
    expect(inspectionData.contexts.every((item) => item.sensitiveContentIncluded === false)).toBe(
      true,
    )
    const serializedInspection = JSON.stringify(inspectionData)
    for (const forbidden of ["sharedContext", "acceptanceCriteria", "resourceBodies", '"notes":']) {
      expect(serializedInspection).not.toContain(forbidden)
    }

    const exportPath = resolve(root, "context-export.json")
    const exported = await executeCli(
      [
        "context",
        "export",
        "--workspace",
        root,
        "--run-id",
        runId,
        "--output",
        "context-export.json",
        "--format",
        "json",
      ],
      context,
    )
    expect(exported).toMatchObject({
      exitCode: 0,
      execution: {
        result: {
          command: "context.export",
          data: { output: exportPath, overwritten: false, policy: "metadata-only" },
        },
      },
    })
    const firstExport = await readFile(exportPath, "utf8")
    expect(firstExport).not.toContain("sharedContext")

    const refusedOverwrite = await executeCli(
      [
        "context",
        "export",
        "--workspace",
        root,
        "--run-id",
        runId,
        "--output",
        "context-export.json",
        "--format",
        "json",
      ],
      context,
    )
    expect(refusedOverwrite).toMatchObject({
      exitCode: 10,
      execution: { result: { diagnostics: [{ code: "RALPH_CONTEXT_EXPORT_EXISTS" }] } },
    })
    expect(await readFile(exportPath, "utf8")).toBe(firstExport)

    const contextManifest = resolve(root, inspectionData.contexts[0]?.path ?? "missing")
    const manifestBefore = await readFile(contextManifest, "utf8")
    const rotations: Array<{ runId: string; reason: string }> = []
    const rotated = await executeCli(
      [
        "context",
        "refresh",
        "--workspace",
        root,
        "--run-id",
        runId,
        "--reason",
        "Bounded public command test",
        "--format",
        "json",
      ],
      {
        ...context,
        contextControl: {
          async rotate(request) {
            rotations.push({ runId: request.runId, reason: request.reason })
            return {
              schemaVersion: 1,
              runId: request.runId,
              disposition: "requested",
              requestedAt: "2026-07-19T18:00:00.000Z",
              nextBoundary: "next-model-call",
            }
          },
        },
      },
    )
    expect(rotated).toMatchObject({
      exitCode: 0,
      execution: {
        result: {
          command: "context.rotate",
          data: { runId, disposition: "requested", nextBoundary: "next-model-call" },
        },
      },
    })
    expect(rotations).toEqual([{ runId, reason: "Bounded public command test" }])
    expect(await readFile(contextManifest, "utf8")).toBe(manifestBefore)

    const unavailable = await executeCli(
      ["context", "rotate", "--workspace", root, "--run-id", runId, "--format", "json"],
      context,
    )
    expect(unavailable).toMatchObject({
      exitCode: 5,
      execution: {
        result: {
          diagnostics: [{ code: "RALPH_CONTEXT_ROTATION_CONTROL_UNAVAILABLE" }],
        },
      },
    })
  }, 20_000)

  test("checkpoint create/list/show and checkpoints aliases share one deterministic surface", async () => {
    const root = await temporaryDirectory()
    await writeFile(resolve(root, ".gitignore"), ".ralph/\n")
    await writeFile(resolve(root, "PRD.md"), "# Checkpoint fixture\n")
    await git(root, "init")
    await git(root, "config", "user.email", "ralph-test@example.invalid")
    await git(root, "config", "user.name", "Ralph Test")
    await git(root, "add", ".gitignore", "PRD.md")
    await git(root, "commit", "-m", "checkpoint fixture")
    await initializeWorkspace(root, VERSION)
    const context = commandContext(root)

    const created = await executeCli(
      [
        "checkpoint",
        "create",
        "--workspace",
        root,
        "--reason",
        "canonical checkpoint",
        "--path",
        "PRD.md",
        "--format",
        "json",
      ],
      context,
    )
    expect(created).toMatchObject({
      exitCode: 0,
      execution: {
        result: {
          command: "checkpoint.create",
          data: { status: "available", reason: "canonical checkpoint", mutationPerformed: true },
        },
      },
    })
    const firstId = (created.execution.result.data as { id: string }).id

    const aliasCreated = await executeCli(
      [
        "checkpoints",
        "create",
        "--workspace",
        root,
        "--reason",
        "alias checkpoint",
        "--format",
        "json",
      ],
      context,
    )
    expect(aliasCreated).toMatchObject({
      exitCode: 0,
      execution: { result: { command: "checkpoint.create", data: { mutationPerformed: true } } },
    })

    const listed = await executeCli(
      ["checkpoint", "list", "--workspace", root, "--format", "json"],
      context,
    )
    const aliasListed = await executeCli(
      ["checkpoints", "list", "--workspace", root, "--format", "json"],
      context,
    )
    expect(listed.exitCode).toBe(0)
    expect(aliasListed.exitCode).toBe(0)
    expect(aliasListed.execution.result).toEqual(listed.execution.result)
    expect(listed.execution.result.data).toMatchObject({ count: 2 })

    const shown = await executeCli(
      ["checkpoint", "show", firstId, "--workspace", root, "--format", "json"],
      context,
    )
    const aliasShown = await executeCli(
      ["checkpoints", "show", firstId, "--workspace", root, "--format", "json"],
      context,
    )
    expect(shown).toMatchObject({
      exitCode: 0,
      execution: {
        result: {
          command: "checkpoint.show",
          data: { id: firstId, reason: "canonical checkpoint", mutationPerformed: false },
        },
      },
    })
    expect(aliasShown.execution.result).toEqual(shown.execution.result)

    const human = captureWriters()
    expect(
      await runCli(["checkpoints", "show", firstId, "--workspace", root], context, human.writers),
    ).toBe(0)
    expect(human.stdout()).toContain(`Checkpoint: ${firstId}`)
    expect(human.stdout()).toContain("Mutation:   none")
    expect(human.stderr()).toBe("")

    const missingId = await executeCli(
      ["checkpoint", "show", "--workspace", root, "--format", "json"],
      context,
    )
    expect(missingId).toMatchObject({
      exitCode: 2,
      execution: { result: { diagnostics: [{ code: "RALPH_CHECKPOINT_ID_MISSING" }] } },
    })
  }, 20_000)

  test("lang current/list/set/update reports provenance and keeps update non-mutating", async () => {
    const root = await initializedWorkspace()
    const context = commandContext(root)

    const current = await executeCli(
      ["lang", "current", "--workspace", root, "--format", "json"],
      context,
    )
    expect(current).toMatchObject({
      exitCode: 0,
      execution: {
        result: {
          command: "lang.current",
          data: {
            configured: "pt-BR",
            presentation: "pt-BR",
            source: "builtin",
            bundled: true,
          },
        },
      },
    })

    const listHuman = captureWriters()
    expect(await runCli(["lang", "list"], context, listHuman.writers)).toBe(0)
    expect(listHuman.stdout()).toContain("en       English")
    expect(listHuman.stdout()).toContain("pt-BR")
    expect(listHuman.stderr()).toBe("")

    const saved = await executeCli(
      ["lang", "set", "en-US", "--scope", "workspace", "--workspace", root, "--format", "json"],
      context,
    )
    expect(saved).toMatchObject({
      exitCode: 0,
      execution: {
        result: {
          command: "lang.set",
          data: { locale: "en", scope: "workspace", affects: "future-runs" },
        },
      },
    })
    const configured = await executeCli(
      ["lang", "current", "--workspace", root, "--format", "json"],
      context,
    )
    expect(configured.execution.result.data).toMatchObject({
      configured: "en",
      presentation: "en",
      source: "workspace",
    })

    const configBeforeUpdate = await readFile(workspaceLayout(root).config, "utf8")
    const updateHuman = captureWriters()
    expect(await runCli(["lang", "update"], context, updateHuman.writers)).toBe(0)
    expect(updateHuman.stdout()).toContain("No network or file mutation was performed")
    expect(updateHuman.stderr()).toBe("")
    const updateJson = await executeCli(["lang", "update", "--format", "json"], context)
    expect(updateJson).toMatchObject({
      exitCode: 0,
      execution: {
        result: {
          command: "lang.update",
          data: { changed: false, update: "release-managed" },
        },
      },
    })
    expect(await readFile(workspaceLayout(root).config, "utf8")).toBe(configBeforeUpdate)

    const unsupported = await executeCli(
      ["lang", "set", "xx", "--scope", "workspace", "--workspace", root, "--format", "json"],
      context,
    )
    expect(unsupported).toMatchObject({
      exitCode: 2,
      execution: { result: { diagnostics: [{ code: "RALPH_LANG_UNSUPPORTED" }] } },
    })
  })

  test("install/update previews and update preflight use only a data-only distribution port", async () => {
    const root = await temporaryDirectory()
    const installRoot = resolve(root, "standalone-install")
    const requests: Array<{
      operation: "install" | "update"
      dryRun: boolean
      checkOnly?: boolean
      expectedVersion?: string
    }> = []
    let signatureResolutions = 0

    const distributionCommands: DistributionCommandService = {
      async install(request) {
        requests.push({
          operation: "install",
          dryRun: request.dryRun ?? false,
          ...(request.expectedVersion ? { expectedVersion: request.expectedVersion } : {}),
        })
        return {
          action: "install",
          installRoot: request.installRoot,
          requestedVersion: request.expectedVersion ?? "1.2.3-nightly.1",
          channel: request.expectedChannel ?? "nightly",
          origin: request.origin,
          mutationPerformed: false,
          runningBinaryReplaced: false,
          launcherMutation: "install",
        }
      },
      async update(request) {
        requests.push({
          operation: "update",
          dryRun: request.dryRun ?? false,
          checkOnly: request.checkOnly ?? false,
          ...(request.expectedVersion ? { expectedVersion: request.expectedVersion } : {}),
        })
        const plan = {
          action: "update" as const,
          installRoot: request.installRoot,
          currentVersion: "1.2.2-nightly.1",
          requestedVersion: request.expectedVersion ?? "1.2.3-nightly.1",
          channel: request.expectedChannel ?? ("nightly" as const),
          ...(request.origin ? { origin: request.origin } : {}),
          mutationPerformed: false as const,
          runningBinaryReplaced: false as const,
          launcherMutation: "preserve" as const,
        }
        return request.checkOnly
          ? {
              ...plan,
              available: true,
              evidenceStatus: "tested",
              evidenceTrust: "signature-verified",
              authenticity: "signature-verified",
              limitations: [],
            }
          : plan
      },
      async rollback() {
        throw new Error("rollback was outside this focused command contract")
      },
      async uninstall() {
        throw new Error("uninstall was outside this focused command contract")
      },
    }
    const context = commandContext(root, {
      distributionCommands,
      async resolveDistributionSignature() {
        signatureResolutions += 1
        return undefined
      },
    })

    const installHuman = captureWriters()
    expect(
      await runCli(
        [
          "install",
          "--install-root",
          installRoot,
          "--manifest",
          "missing-release-manifest.json",
          "--channel",
          "nightly",
          "--to-version",
          "1.2.3-nightly.1",
          "--dry-run",
        ],
        context,
        installHuman.writers,
      ),
    ).toBe(0)
    expect(installHuman.stdout()).toContain("Action:       install")
    expect(installHuman.stdout()).toContain("Mutation:     none")
    expect(installHuman.stderr()).toBe("")
    expect(requests[0]).toEqual({
      operation: "install",
      dryRun: true,
      expectedVersion: "1.2.3-nightly.1",
    })
    expect(signatureResolutions).toBe(0)
    await expectMissing(resolve(installRoot, "current.json"))

    const updatePreview = await executeCli(
      [
        "update",
        "--install-root",
        installRoot,
        "--channel",
        "nightly",
        "--to-version",
        "1.2.3-nightly.1",
        "--dry-run",
        "--format",
        "json",
      ],
      context,
    )
    expect(updatePreview).toMatchObject({
      exitCode: 0,
      execution: {
        result: {
          command: "update",
          data: {
            action: "update",
            mutationPerformed: false,
            runningBinaryReplaced: false,
          },
        },
      },
    })
    expect(requests[1]).toEqual({
      operation: "update",
      dryRun: true,
      checkOnly: false,
      expectedVersion: "1.2.3-nightly.1",
    })
    expect(signatureResolutions).toBe(0)

    const checkHuman = captureWriters()
    expect(
      await runCli(
        [
          "update",
          "--install-root",
          installRoot,
          "--channel",
          "nightly",
          "--to-version",
          "1.2.3-nightly.1",
          "--check",
          "--dry-run",
        ],
        context,
        checkHuman.writers,
      ),
    ).toBe(0)
    expect(checkHuman.stdout()).toContain("Update:       available")
    expect(checkHuman.stdout()).toContain("Mutation:     none")
    expect(checkHuman.stderr()).toBe("")
    expect(requests[2]).toEqual({
      operation: "update",
      dryRun: true,
      checkOnly: true,
      expectedVersion: "1.2.3-nightly.1",
    })
    expect(signatureResolutions).toBe(1)

    const checkJson = await executeCli(
      [
        "update",
        "--install-root",
        installRoot,
        "--channel",
        "nightly",
        "--to-version",
        "1.2.3-nightly.1",
        "--check",
        "--dry-run",
        "--format",
        "json",
      ],
      context,
    )
    expect(checkJson).toMatchObject({
      exitCode: 0,
      execution: {
        result: {
          command: "update",
          data: {
            available: true,
            evidenceStatus: "tested",
            evidenceTrust: "signature-verified",
            authenticity: "signature-verified",
            mutationPerformed: false,
          },
        },
      },
    })
    expect(signatureResolutions).toBe(2)
    await expectMissing(resolve(installRoot, "current.json"))
    await expectMissing(resolve(root, "missing-release-manifest.json"))
  })
})
