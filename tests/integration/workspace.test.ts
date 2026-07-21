import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readdir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { executeCli } from "@ralph/commands"
import type { RalphError } from "@ralph/domain"
import {
  findWorkspaceRoot,
  initializeWorkspace,
  inspectWorkspace,
  isDirectoryEmpty,
  listWorkspaceFiles,
  readEvents,
  readWorkspaceConfig,
  workspaceLayout,
} from "@ralph/persistence"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const VERSION = "0.1.0-s01-test"
const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await createTestDirectory()
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

describe("safe Ralph v2 workspace initialization", () => {
  test("initializes paths with spaces and Unicode, then remains idempotent", async () => {
    const temporary = await temporaryDirectory()
    const root = join(temporary, "Projeto Ágil 日本語 com espaços")
    await mkdir(root)

    const first = await initializeWorkspace(root, VERSION)
    const identityBefore = await readFile(workspaceLayout(root).identity, "utf8")
    const filesBefore = await listWorkspaceFiles(root)
    expect(first).toMatchObject({ created: true, repaired: false, root, eventCount: 1 })
    expect(first.workspaceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    expect(filesBefore).toEqual(
      expect.arrayContaining([
        ".ralph/config.yaml",
        ".ralph/events.jsonl",
        ".ralph/state/ledger.sqlite",
        ".ralph/state/migrations/0001-initial.sql",
        ".ralph/workspace.json",
      ]),
    )
    expect(filesBefore.some((path) => /prd/i.test(path))).toBeFalse()
    expect(filesBefore).not.toContain(".ralph/state/ledger.sqlite-wal")
    expect(filesBefore).not.toContain(".ralph/state/ledger.sqlite-shm")
    expect((await readWorkspaceConfig(workspaceLayout(root).config)).schema_version).toBe(1)
    const initializedEvents = readEvents(workspaceLayout(root).ledger)
    expect(initializedEvents[0]?.payload).toEqual({
      created: true,
      repaired: false,
      version: VERSION,
    })
    expect(JSON.stringify(initializedEvents)).not.toContain(root)

    const second = await initializeWorkspace(root, "99.0.0-should-not-rewrite")
    expect(second).toMatchObject({
      created: false,
      repaired: false,
      root,
      workspaceId: first.workspaceId,
      eventCount: 1,
    })
    expect(await readFile(workspaceLayout(root).identity, "utf8")).toBe(identityBefore)
    expect(await listWorkspaceFiles(root)).toEqual(filesBefore)
  })

  test("initializes and discovers a workspace beyond the classic Windows MAX_PATH boundary", async () => {
    const temporary = await temporaryDirectory()
    const segments = Array.from(
      { length: 12 },
      (_, index) => `segmento-${String(index).padStart(2, "0")}-Ágil-長い-path`,
    )
    const root = join(temporary, ...segments)
    await mkdir(root, { recursive: true })
    expect(root.length).toBeGreaterThan(260)

    const initialized = await initializeWorkspace(root, VERSION)
    const descendant = join(root, "src", "recurso", "profundo")
    await mkdir(descendant, { recursive: true })

    expect(await findWorkspaceRoot(descendant)).toBe(root)
    expect(await inspectWorkspace(descendant)).toMatchObject({
      initialized: true,
      state: "ready",
      root,
      workspaceId: initialized.workspaceId,
    })
    expect(await listWorkspaceFiles(root)).toEqual(
      expect.arrayContaining([
        ".ralph/config.yaml",
        ".ralph/state/ledger.sqlite",
        ".ralph/workspace.json",
      ]),
    )
  })

  test("discovers a persisted workspace identity from descendants", async () => {
    const root = await temporaryDirectory()
    const nested = join(root, "src", "feature", "deep")
    await mkdir(nested, { recursive: true })
    const initialized = await initializeWorkspace(root, VERSION)

    expect(await findWorkspaceRoot(nested)).toBe(root)
    expect(await inspectWorkspace(nested)).toMatchObject({
      initialized: true,
      state: "ready",
      root,
      workspaceId: initialized.workspaceId,
      eventCount: 1,
      eventCursor: 1,
      lastEventType: "workspace.initialized",
    })
  })

  test("does not skip a malformed ancestor workspace sentinel", async () => {
    const root = await temporaryDirectory()
    const nested = join(root, "src", "deep")
    const identity = workspaceLayout(root).identity
    await Promise.all([mkdir(nested, { recursive: true }), mkdir(identity, { recursive: true })])

    await expect(inspectWorkspace(nested)).rejects.toMatchObject({
      code: "RALPH_MANAGED_PATH_UNSAFE",
      exitCode: 7,
      diagnostic: { file: identity },
    })
  })

  test("does not cross a foreign nested .ralph boundary to attach to a v2 ancestor", async () => {
    const root = await temporaryDirectory()
    await initializeWorkspace(root, VERSION)
    const nested = join(root, "nested-project")
    await mkdir(nested)
    const foreignBoundary = join(nested, ".ralph")
    await writeFile(foreignBoundary, "foreign nested state\n")

    await expect(inspectWorkspace(nested)).rejects.toMatchObject({
      code: "RALPH_FOREIGN_STATE_EXISTS",
      exitCode: 7,
      diagnostic: { file: foreignBoundary },
    })
    expect(await readFile(foreignBoundary, "utf8")).toBe("foreign nested state\n")
  })

  test("refuses foreign non-empty .ralph state even with force and preserves every byte", async () => {
    const root = await temporaryDirectory()
    const layout = workspaceLayout(root)
    await mkdir(layout.ralph)
    const foreign = join(layout.ralph, "state.json")
    const sentinel = '{"legacy":true,"doNotTouch":"á"}\n'
    await writeFile(foreign, sentinel, "utf8")

    for (const force of [false, true]) {
      await expect(initializeWorkspace(root, VERSION, { force })).rejects.toMatchObject({
        code: "RALPH_FOREIGN_STATE_EXISTS",
        exitCode: 7,
      } satisfies Partial<RalphError>)
      expect(await readFile(foreign, "utf8")).toBe(sentinel)
      expect(await readdir(layout.ralph)).toEqual(["state.json"])
    }
  })

  test("classifies a regular .ralph file as foreign state without replacing it", async () => {
    const root = await temporaryDirectory()
    const foreignPath = join(root, ".ralph")
    const original = "foreign-state-file\n"
    await writeFile(foreignPath, original, "utf8")

    await expect(initializeWorkspace(root, VERSION)).rejects.toMatchObject({
      code: "RALPH_FOREIGN_STATE_EXISTS",
      exitCode: 7,
    } satisfies Partial<RalphError>)
    expect(await Bun.file(foreignPath).text()).toBe(original)
  })

  test("does not call an uninspectable path empty", async () => {
    const root = await temporaryDirectory()
    const path = join(root, "not-a-directory")
    await writeFile(path, "sentinel")

    await expect(isDirectoryEmpty(path)).rejects.toMatchObject({
      code: "RALPH_WORKSPACE_INSPECTION_FAILED",
      exitCode: 10,
      diagnostic: { file: path },
    })
    expect(await readFile(path, "utf8")).toBe("sentinel")
  })

  test("rejects a linked managed state directory before writing outside the workspace", async () => {
    const root = await temporaryDirectory()
    await initializeWorkspace(root, VERSION)
    const layout = workspaceLayout(root)
    const state = dirname(layout.ledger)
    const originalState = join(layout.ralph, "state-original")
    const external = join(root, "external-state-target")
    await mkdir(external)
    await rename(state, originalState)
    await symlink(external, state, process.platform === "win32" ? "junction" : "dir")
    try {
      await expect(initializeWorkspace(root, VERSION, { force: true })).rejects.toMatchObject({
        code: "RALPH_MANAGED_PATH_UNSAFE",
        exitCode: 7,
      } satisfies Partial<RalphError>)
      expect(await readdir(external)).toEqual([])
    } finally {
      await unlink(state)
      await rename(originalState, state)
    }
  })

  test("force repairs only missing v2 files and preserves identity, ledger and valid config", async () => {
    const root = await temporaryDirectory()
    const initialized = await initializeWorkspace(root, VERSION)
    const layout = workspaceLayout(root)
    const identityBefore = await readFile(layout.identity, "utf8")
    const eventsBefore = readEvents(layout.ledger)

    await unlink(layout.config)
    await expect(initializeWorkspace(root, VERSION)).rejects.toMatchObject({
      code: "RALPH_WORKSPACE_INCOMPLETE",
      exitCode: 5,
    } satisfies Partial<RalphError>)

    const repaired = await initializeWorkspace(root, VERSION, { force: true })
    expect(repaired).toMatchObject({
      created: false,
      repaired: true,
      workspaceId: initialized.workspaceId,
      eventCount: 2,
    })
    expect(await readFile(layout.identity, "utf8")).toBe(identityBefore)
    const eventsAfter = readEvents(layout.ledger)
    expect(eventsAfter[0]).toEqual(eventsBefore[0])
    expect(eventsAfter[1]).toMatchObject({
      sequence: 2,
      type: "workspace.repaired",
      workspaceId: initialized.workspaceId,
      payload: { created: false, repaired: true },
    })
    expect(eventsAfter[1]?.payload.repairedPaths).toContain(".ralph/config.yaml")
    expect(JSON.stringify(eventsAfter)).not.toContain(root)

    const configBefore = await readFile(layout.config, "utf8")
    const forcedAgain = await initializeWorkspace(root, VERSION, { force: true })
    expect(forcedAgain.repaired).toBeFalse()
    expect(await readFile(layout.config, "utf8")).toBe(configBefore)
  })

  test("status and init reject the same missing reserved workspace path", async () => {
    const root = await temporaryDirectory()
    await initializeWorkspace(root, VERSION)
    const layout = workspaceLayout(root)
    await rm(layout.runs, { recursive: true })

    for (const operation of [
      () => inspectWorkspace(root),
      () => initializeWorkspace(root, VERSION),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        code: "RALPH_WORKSPACE_INCOMPLETE",
        exitCode: 5,
        diagnostic: { details: { missingPaths: [layout.runs] } },
      })
    }

    await initializeWorkspace(root, VERSION, { force: true })
    expect(await inspectWorkspace(root)).toMatchObject({ state: "ready", initialized: true })
  })
})

describe("status without initialization", () => {
  test("is successful, reports uninitialized and does not mutate the directory", async () => {
    const root = await temporaryDirectory()
    const result = await executeCli(["status", "--format", "json"], {
      version: VERSION,
      cwd: root,
      environment: { RALPH_CONFIG_HOME: join(root, "global-config") },
    })

    expect(result.exitCode).toBe(0)
    expect(result.format).toBe("json")
    expect(result.execution.result).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: "status",
      data: {
        initialized: false,
        state: "uninitialized",
        root,
        eventCursor: 0,
        eventCount: 0,
      },
      diagnostics: [],
    })
    expect(await readdir(root)).toEqual([])
  })
})
