import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { z } from "zod"
import {
  createBuiltinToolRegistry,
  decideToolPermission,
  InMemoryToolJournal,
  jsonInputSchema,
  sha256,
  ToolCallSchema,
  ToolHost,
  ToolPolicySchema,
  ToolRegistry,
  type ToolSession,
  WorkspacePathResolver,
} from "../src"

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function policy(overrides: Record<string, unknown> = {}) {
  return ToolPolicySchema.parse({
    schemaVersion: 1,
    role: "executor",
    securityMode: "safe",
    interactive: false,
    readScopes: ["."],
    writeScopes: ["."],
    protectedPaths: ["PRD.md"],
    commandRules: [],
    limits: {},
    ...overrides,
  })
}

function builtinHost() {
  return new ToolHost({
    registry: createBuiltinToolRegistry(),
    journal: new InMemoryToolJournal(),
    process: {
      which: () => null,
      async run() {
        throw new Error("not used")
      },
    },
    artifacts: {
      async publish() {
        throw new Error("not used")
      },
    },
    events: { emit() {} },
  })
}

function executorSession(root: string): ToolSession {
  return {
    runId: "run",
    documentId: "doc",
    taskId: "task",
    attemptId: "attempt",
    modelCallId: "model",
    workspaceRoot: root,
    policy: policy(),
    maximumToolCalls: 10,
  }
}

function fsWriteCall(id: string, argumentsValue: Record<string, unknown>) {
  return ToolCallSchema.parse({
    schemaVersion: 1,
    id,
    modelCallId: "model",
    providerToolCallId: `provider-${id}`,
    name: "fs.write",
    arguments: argumentsValue,
    requestedAt: new Date().toISOString(),
  })
}

function processCall(id: string, args: readonly string[]) {
  return ToolCallSchema.parse({
    schemaVersion: 1,
    id,
    modelCallId: "model",
    providerToolCallId: `provider-${id}`,
    name: "process.exec",
    arguments: {
      mode: "direct",
      executable: "fixture-command",
      args: [...args],
      cwd: ".",
    },
    requestedAt: new Date().toISOString(),
  })
}

function processHost(executions: string[][]) {
  const journal = new InMemoryToolJournal()
  const host = new ToolHost({
    registry: createBuiltinToolRegistry(),
    journal,
    process: {
      which: () => null,
      async run(request) {
        if (request.shell !== false) throw new Error("direct argv unexpectedly entered a shell")
        executions.push([request.executable, ...request.args])
        return {
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          stdoutBytes: 2,
          stderrBytes: 0,
          outputTruncated: false,
          rawOutputTruncated: false,
          timedOut: false,
          cancelled: false,
          treeTerminated: false,
          outputRefs: [],
          durationMs: 1,
        }
      },
    },
    artifacts: {
      async publish() {
        throw new Error("not used")
      },
    },
    events: { emit() {} },
  })
  return { host, journal }
}

function processPolicy(securityMode: "safe" | "auto" | "dangerous", allowUnlistedProcess = false) {
  return policy({
    securityMode,
    headlessAsk: "deny",
    toolRules: { "process.exec": "allow" },
    commandRules: [
      {
        id: "fixture-exact",
        executable: "fixture-command",
        exactArgs: ["--approved"],
        shell: false,
        risk: "process",
      },
    ],
    allowUnlistedProcess,
  })
}

describe("tool host governance", () => {
  test("never exposes the Ralph control directory to executor read tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-tool-host-control-read-"))
    temporary.push(root)
    await mkdir(resolve(root, ".ralph", "runs", "run", "evaluation"), { recursive: true })
    await writeFile(
      resolve(root, ".ralph", "runs", "run", "evaluation", "assessment.json"),
      "private control-plane assessment",
    )
    const resolver = await WorkspacePathResolver.create(
      root,
      policy({
        securityMode: "dangerous",
        readScopes: ["."],
        toolRules: { "fs.read": "allow" },
      }),
    )

    expect(resolver.isProtected(".ralph/runs/run/evaluation/assessment.json")).toBeTrue()
    await expect(
      resolver.resolve(".ralph/runs/run/evaluation/assessment.json", "read", {
        mustExist: true,
      }),
    ).rejects.toMatchObject({ code: "RALPH_TOOL_PATH_PROTECTED" })
  })

  test("materializes exactly ten builtins and keeps judges read-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-tool-host-"))
    temporary.push(root)
    const registry = createBuiltinToolRegistry()
    expect(registry.names()).toHaveLength(10)
    const host = new ToolHost({
      registry,
      journal: new InMemoryToolJournal(),
      process: {
        which: () => null,
        async run() {
          throw new Error("not used")
        },
      },
      artifacts: {
        async publish() {
          throw new Error("not used")
        },
      },
      events: { emit() {} },
    })
    const session: ToolSession = {
      runId: "run",
      documentId: "doc",
      taskId: "task",
      attemptId: "attempt",
      modelCallId: "model",
      workspaceRoot: root,
      policy: policy({ role: "judge" }),
      maximumToolCalls: 10,
    }
    const definitions = await host.materialize(session)
    expect(definitions.every((tool) => tool.risk === "read" && !tool.mutatesWorkspace)).toBe(true)
    expect(definitions.map((tool) => tool.name)).not.toContain("process.exec")
  })

  test("denies a judge write request even under a nominal dangerous allow rule", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-tool-host-judge-write-"))
    temporary.push(root)
    const target = join(root, "judge-must-not-write.txt")
    const session: ToolSession = {
      ...executorSession(root),
      policy: policy({
        role: "judge",
        securityMode: "dangerous",
        toolRules: { "fs.write": "allow" },
      }),
    }

    const settlement = await builtinHost().execute(
      fsWriteCall("judge-write", {
        path: "judge-must-not-write.txt",
        content: "forbidden",
        precondition: { kind: "absent" },
        createParents: false,
      }),
      session,
    )

    expect(settlement).toMatchObject({
      outcome: "denied",
      effects: [],
      recovery: "effect-absent",
      content: {
        authorization: {
          action: "deny",
          auditedOverride: false,
          reason: expect.stringContaining("Judge sessions are read-only"),
        },
      },
    })
    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("settles additive tool schema abuse as invalid before any effect", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-tool-host-schema-abuse-"))
    temporary.push(root)
    const target = join(root, "schema-abuse.txt")

    const settlement = await builtinHost().execute(
      fsWriteCall("schema-abuse", {
        path: "schema-abuse.txt",
        content: "must-not-be-written",
        precondition: { kind: "absent" },
        createParents: false,
        futureAuthority: { completeTask: true },
      }),
      executorSession(root),
    )

    expect(settlement).toMatchObject({
      outcome: "invalid",
      effects: [],
      recovery: "effect-absent",
      content: { code: "RALPH_TOOL_CALL_INVALID" },
    })
    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("named rules cannot bypass shell, scope, judge, or protected hard invariants", () => {
    const configured = policy({
      securityMode: "dangerous",
      allowUnlistedProcess: true,
      toolRules: { "process.exec": "allow", "fs.read": "ask" },
    })
    expect(
      decideToolPermission(
        configured,
        {
          risk: "process",
          mutatesWorkspace: true,
          pathProtected: false,
          pathInReadScope: true,
          pathInWriteScope: true,
          shell: true,
        },
        "process.exec",
      ).action,
    ).toBe("deny")
    expect(
      decideToolPermission(
        configured,
        {
          risk: "read",
          mutatesWorkspace: false,
          pathProtected: false,
          pathInReadScope: true,
          pathInWriteScope: false,
          shell: false,
        },
        "fs.read",
      ).action,
    ).toBe("ask")
  })

  test("safe mode requires an exact argv rule even when process.exec is nominally allowed", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-tool-host-process-"))
    temporary.push(root)
    const executions: string[][] = []
    const { host, journal } = processHost(executions)
    const session = { ...executorSession(root), policy: processPolicy("safe") }

    const exact = await host.execute(processCall("safe-exact", ["--approved"]), session)
    const unlisted = await host.execute(processCall("safe-unlisted", ["--different"]), session)

    expect(exact.outcome).toBe("success")
    expect(unlisted.outcome).toBe("denied")
    expect(executions).toEqual([["fixture-command", "--approved"]])
    expect(
      journal.records().find((record) => record.id === "safe-unlisted")?.authorization,
    ).toMatchObject({ action: "deny", auditedOverride: false })
  })

  test("auto mode asks and therefore denies headless argv outside the exact command rule", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-tool-host-process-"))
    temporary.push(root)
    const executions: string[][] = []
    const { host } = processHost(executions)
    const session = { ...executorSession(root), policy: processPolicy("auto") }

    const exact = await host.execute(processCall("auto-exact", ["--approved"]), session)
    const unlisted = await host.execute(processCall("auto-unlisted", ["--different"]), session)

    expect(exact.outcome).toBe("success")
    expect(unlisted.outcome).toBe("denied")
    expect(executions).toEqual([["fixture-command", "--approved"]])
  })

  test("allows an unsafe headless ask only when explicit and records the audited override", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-tool-host-headless-ask-"))
    temporary.push(root)
    const executions: string[][] = []
    const { host, journal } = processHost(executions)
    const session = {
      ...executorSession(root),
      policy: ToolPolicySchema.parse({ ...processPolicy("auto"), headlessAsk: "allow" }),
    }

    const settlement = await host.execute(
      processCall("headless-explicit", ["--outside-exact-rule"]),
      session,
    )

    expect(settlement.outcome).toBe("success")
    expect(executions).toEqual([["fixture-command", "--outside-exact-rule"]])
    expect(
      journal.records().find((record) => record.id === "headless-explicit")?.authorization,
    ).toMatchObject({ action: "allow", auditedOverride: true })
  })

  test("matches metacharacters as one literal argv value without invoking a shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-tool-host-argv-literal-"))
    temporary.push(root)
    const executions: string[][] = []
    const { host } = processHost(executions)
    const literal = "value;$(touch injected.txt)&|>"
    const session = {
      ...executorSession(root),
      policy: policy({
        securityMode: "safe",
        headlessAsk: "deny",
        toolRules: { "process.exec": "allow" },
        commandRules: [
          {
            id: "literal-metacharacters",
            executable: "fixture-command",
            exactArgs: ["--value", literal],
            shell: false,
            risk: "process",
          },
        ],
      }),
    }

    const exact = await host.execute(processCall("argv-literal", ["--value", literal]), session)
    const drifted = await host.execute(
      processCall("argv-drifted", ["--value", `${literal}x`]),
      session,
    )

    expect(exact.outcome).toBe("success")
    expect(drifted.outcome).toBe("denied")
    expect(executions).toEqual([["fixture-command", "--value", literal]])
    await expect(readFile(join(root, "injected.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  test("dangerous mode still needs an exact rule unless unlisted processes are explicitly enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-tool-host-process-"))
    temporary.push(root)
    const executions: string[][] = []
    const { host, journal } = processHost(executions)
    const bounded = { ...executorSession(root), policy: processPolicy("dangerous") }

    const exact = await host.execute(processCall("dangerous-exact", ["--approved"]), bounded)
    const unlisted = await host.execute(
      processCall("dangerous-unlisted-denied", ["--different"]),
      bounded,
    )
    const explicit = await host.execute(
      processCall("dangerous-unlisted-explicit", ["--explicitly-unlisted"]),
      {
        ...executorSession(root),
        policy: processPolicy("dangerous", true),
      },
    )

    expect(exact.outcome).toBe("success")
    expect(unlisted.outcome).toBe("denied")
    expect(explicit.outcome).toBe("success")
    expect(executions).toEqual([
      ["fixture-command", "--approved"],
      ["fixture-command", "--explicitly-unlisted"],
    ])
    expect(
      journal.records().find((record) => record.id === "dangerous-unlisted-explicit")
        ?.authorization,
    ).toMatchObject({ action: "allow", auditedOverride: true })
  })

  test("persists intent before effects and does not replay a provider call", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-tool-host-"))
    temporary.push(root)
    const order: string[] = []
    class TrackingJournal extends InMemoryToolJournal {
      override async start(id: string, at: string) {
        order.push("start")
        return super.start(id, at)
      }
    }
    const input = z.object({ content: z.string() }).strict()
    const registry = new ToolRegistry()
    registry.register({
      definition: {
        schemaVersion: 1,
        name: "test.effect",
        description: "test effect",
        inputSchema: jsonInputSchema(input),
        risk: "write",
        mutatesWorkspace: true,
      },
      inputSchema: input,
      assess() {
        return {
          facts: {
            risk: "write",
            mutatesWorkspace: true,
            pathProtected: false,
            pathInReadScope: true,
            pathInWriteScope: true,
            shell: false,
          },
          reason: "test",
        }
      },
      async execute(value) {
        order.push("effect")
        await Bun.write(join(root, "effect.txt"), input.parse(value).content)
        return { content: { ok: true }, recovery: "reconcile-by-precondition" }
      },
    })
    const journal = new TrackingJournal()
    const host = new ToolHost({
      registry,
      journal,
      process: {
        which: () => null,
        async run() {
          throw new Error("not used")
        },
      },
      artifacts: {
        async publish() {
          throw new Error("not used")
        },
      },
      events: { emit() {} },
    })
    const session: ToolSession = {
      runId: "run",
      documentId: "doc",
      taskId: "task",
      attemptId: "attempt",
      modelCallId: "model",
      workspaceRoot: root,
      policy: policy(),
      maximumToolCalls: 2,
      secretValues: ["super-secret"],
    }
    const call = ToolCallSchema.parse({
      schemaVersion: 1,
      id: "call",
      modelCallId: "model",
      providerToolCallId: "provider-call",
      name: "test.effect",
      arguments: { content: "super-secret" },
      requestedAt: new Date().toISOString(),
    })
    const first = await host.execute(call, session)
    const second = await host.execute(call, session)
    expect(first.outcome).toBe("success")
    expect(second).toEqual(first)
    expect(order).toEqual(["start", "effect"])
    expect(await readFile(join(root, "effect.txt"), "utf8")).toBe("super-secret")
    expect(journal.records()[0]?.argumentsRedacted).toEqual({ content: "[REDACTED]" })
  })
})

describe("workspace path escape rejection", () => {
  test("rejects parent traversal and Windows-equivalent backslash traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-tool-host-paths-"))
    temporary.push(root)
    const resolver = await WorkspacePathResolver.create(root, policy())

    for (const candidate of ["../outside.txt", "nested/../../outside.txt"]) {
      await expect(resolver.resolve(candidate, "write")).rejects.toMatchObject({
        code: "RALPH_TOOL_PATH_TRAVERSAL",
      })
    }
    await expect(resolver.resolve("..\\outside.txt", "write")).rejects.toMatchObject({
      code: "RALPH_TOOL_PATH_NOT_PORTABLE",
    })
  })

  test("rejects native, POSIX, Windows drive, and UNC absolute paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-tool-host-paths-"))
    temporary.push(root)
    const resolver = await WorkspacePathResolver.create(root, policy())
    const nativeAbsolute = resolve(root, "capability.txt").replaceAll("\\", "/")
    const absolutePaths = [
      nativeAbsolute,
      "/tmp/ralph-tool-host-outside.txt",
      "C:/Windows/System32/ralph-tool-host-outside.txt",
      "//server/share/ralph-tool-host-outside.txt",
    ]

    for (const candidate of absolutePaths) {
      await expect(resolver.resolve(candidate, "write")).rejects.toMatchObject({
        code: "RALPH_TOOL_PATH_ABSOLUTE",
      })
    }
  })

  test("ToolHost settles traversal and absolute writes as invalid without effects", async () => {
    const container = await mkdtemp(join(tmpdir(), "ralph-tool-host-escape-"))
    temporary.push(container)
    const root = join(container, "workspace")
    const outside = join(container, "outside.txt")
    await mkdir(root)
    const session = executorSession(root)
    const rejectedPaths = [
      "../outside.txt",
      "nested/../../outside.txt",
      "..\\outside.txt",
      resolve(root, "inside-absolute.txt").replaceAll("\\", "/"),
      resolve(outside).replaceAll("\\", "/"),
      "/tmp/ralph-tool-host-outside.txt",
      "C:/Windows/System32/ralph-tool-host-outside.txt",
      "//server/share/ralph-tool-host-outside.txt",
    ]
    const host = builtinHost()

    for (const [index, path] of rejectedPaths.entries()) {
      const settlement = await host.execute(
        fsWriteCall(`escape-${index + 1}`, {
          path,
          content: "must-not-be-written",
          precondition: { kind: "absent" },
          createParents: true,
        }),
        session,
      )
      expect(settlement).toMatchObject({
        outcome: "invalid",
        effects: [],
        recovery: "effect-absent",
      })
    }

    await expect(readFile(outside, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(join(root, "inside-absolute.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    })
  })
})

describe("atomic workspace writes", () => {
  test("creates a file while tolerating only the staged parent metadata change", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-tool-host-write-"))
    temporary.push(root)
    await mkdir(join(root, "product"))

    const settlement = await builtinHost().execute(
      fsWriteCall("create", {
        path: "product/capability.txt",
        content: "created",
        precondition: { kind: "absent" },
        createParents: false,
      }),
      executorSession(root),
    )

    expect(settlement.outcome).toBe("success")
    expect(settlement.effects).toEqual([
      expect.objectContaining({ path: "product/capability.txt", kind: "created" }),
    ])
    expect(await readFile(join(root, "product", "capability.txt"), "utf8")).toBe("created")
  })

  test("atomically replaces an existing file under its SHA-256 precondition", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-tool-host-write-"))
    temporary.push(root)
    await mkdir(join(root, "product"))
    await writeFile(join(root, "product", "capability.txt"), "before", "utf8")

    const settlement = await builtinHost().execute(
      fsWriteCall("replace", {
        path: "product/capability.txt",
        content: "after",
        precondition: { kind: "sha256", value: sha256(Buffer.from("before", "utf8")) },
        createParents: false,
      }),
      executorSession(root),
    )

    expect(settlement.outcome).toBe("success")
    expect(settlement.effects).toEqual([
      expect.objectContaining({ path: "product/capability.txt", kind: "modified" }),
    ])
    expect(await readFile(join(root, "product", "capability.txt"), "utf8")).toBe("after")
  })

  test("rejects a parent directory identity swap during staging", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-tool-host-write-"))
    temporary.push(root)
    await mkdir(join(root, "product"))
    const resolver = await WorkspacePathResolver.create(root, policy())
    const target = await resolver.resolve("product/capability.txt", "write")
    const revalidateAfterStaging = await resolver.guardParentDirectoryMetadataMutation(target)

    await rename(join(root, "product"), join(root, "original-product"))
    await mkdir(join(root, "product"))

    await expect(revalidateAfterStaging()).rejects.toMatchObject({
      code: "RALPH_TOOL_PATH_CHANGED",
    })
  })

  test("rejects a symlink or junction parent escape during staging", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-tool-host-write-"))
    const outside = await mkdtemp(join(tmpdir(), "ralph-tool-host-outside-"))
    temporary.push(root, outside)
    await mkdir(join(root, "product"))
    const resolver = await WorkspacePathResolver.create(root, policy())
    const target = await resolver.resolve("product/capability.txt", "write")
    const revalidateAfterStaging = await resolver.guardParentDirectoryMetadataMutation(target)

    await rename(join(root, "product"), join(root, "original-product"))
    await symlink(outside, join(root, "product"), process.platform === "win32" ? "junction" : "dir")

    await expect(revalidateAfterStaging()).rejects.toMatchObject({
      code: "RALPH_TOOL_PATH_CHANGED",
    })
  })

  test("keeps the target fingerprint strict while parent metadata is permitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-tool-host-write-"))
    temporary.push(root)
    await mkdir(join(root, "product"))
    const targetPath = join(root, "product", "capability.txt")
    await writeFile(targetPath, "before", "utf8")
    const resolver = await WorkspacePathResolver.create(root, policy())
    const target = await resolver.resolve("product/capability.txt", "write", { mustExist: true })
    const revalidateAfterStaging = await resolver.guardParentDirectoryMetadataMutation(target)

    await writeFile(targetPath, "changed-by-another-actor", "utf8")

    await expect(revalidateAfterStaging()).rejects.toMatchObject({
      code: "RALPH_TOOL_PATH_CHANGED",
    })
  })
})
