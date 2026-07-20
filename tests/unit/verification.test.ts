import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readdir, readFile, readlink, symlink, unlink, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { CommandSpecSchema, VerificationSpecSchema } from "@ralph-next/prd"
import {
  captureWorkspaceBaseline,
  collectArtifactEvidence,
  compareWorkspaceBaselines,
  gateResultFromVerification,
  readVerifiedContentReference,
  runStructuredCommand,
  runVerification,
  verifyWorkspaceBaselineContent,
} from "@ralph-next/verification"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await createTestDirectory()
  temporaryDirectories.push(path)
  return path
}

async function readAllUtf8Files(directory: string): Promise<string[]> {
  const values: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) values.push(...(await readAllUtf8Files(path)))
    else if (entry.isFile()) values.push(await readFile(path, "utf8"))
  }
  return values
}

async function runGit(root: string, args: string[]): Promise<void> {
  const git = Bun.which("git")
  if (!git) throw new Error("Git is required by the workspace control-facts test")
  const child = Bun.spawn([git, ...args], {
    cwd: root,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    windowsHide: true,
  })
  const exitCode = await child.exited
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(child.stderr).text()}`)
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

describe("workspace evidence", () => {
  test("attributes only post-baseline changes and diagnoses paths outside document scope", async () => {
    const root = await temporaryDirectory()
    await mkdir(resolve(root, "app"), { recursive: true })
    await writeFile(resolve(root, "app", "dirty-before.txt"), "user work\n")
    await writeFile(resolve(root, "outside.txt"), "unchanged\n")
    const before = await captureWorkspaceBaseline(root, { scope: "app" })

    await writeFile(resolve(root, "app", "new.txt"), "executor work\n")
    await writeFile(resolve(root, "outside.txt"), "unexpected\n")
    const after = await captureWorkspaceBaseline(root, { scope: "app" })
    const changes = compareWorkspaceBaselines(before, after)

    expect(changes.created).toEqual(["app/new.txt"])
    expect(changes.modified).toEqual(["outside.txt"])
    expect(changes.outsideScope).toEqual(["outside.txt"])
    expect(await readFile(resolve(root, "app", "dirty-before.txt"), "utf8")).toBe("user work\n")
  })

  test("freezes file bytes and raw symlink targets under the run before later removal", async () => {
    const root = await temporaryDirectory()
    const store = { directory: resolve(root, ".ralph", "runs", "run-proof", "artifacts") }
    await mkdir(resolve(root, "source", "target"), { recursive: true })
    await writeFile(resolve(root, "source", "payload.bin"), Uint8Array.from([0, 1, 2, 255]))
    const linkPath = resolve(root, "source", "target-link")
    await symlink(
      resolve(root, "source", "target"),
      linkPath,
      process.platform === "win32" ? "junction" : "dir",
    )
    const expectedLinkTarget = await readlink(linkPath, { encoding: "buffer" })

    const baseline = await captureWorkspaceBaseline(root, { objectStore: store })
    const payload = baseline.files["source/payload.bin"]
    const link = baseline.files["source/target-link"]
    if (!payload?.contentRef || !link?.contentRef) {
      throw new Error("Materialized workspace snapshots must contain immutable refs")
    }
    expect(payload.contentRef).toMatch(/^\.ralph\/runs\/run-proof\/artifacts\/sha256\//)
    expect(link.contentRef).toMatch(/^\.ralph\/runs\/run-proof\/artifacts\/sha256\//)

    await writeFile(resolve(root, "source", "payload.bin"), "later bytes")
    await unlink(linkPath)
    expect(
      await readVerifiedContentReference(root, payload.contentRef, payload.sha256, payload.size),
    ).toEqual(Uint8Array.from([0, 1, 2, 255]))
    expect(
      Buffer.from(
        await readVerifiedContentReference(root, link.contentRef, link.sha256, link.size),
      ),
    ).toEqual(expectedLinkTarget)
  })

  test("freezes declared artifacts and rejects a corrupted immutable object", async () => {
    const root = await temporaryDirectory()
    const store = { directory: resolve(root, ".ralph", "runs", "run-artifact", "artifacts") }
    await mkdir(resolve(root, "deliveries"), { recursive: true })
    await writeFile(resolve(root, "deliveries", "proof.bin"), Uint8Array.from([9, 8, 7, 0]))
    const specification = VerificationSpecSchema.parse({
      id: "artifact-proof",
      type: "artifact",
      artifactId: "proof",
      path: "deliveries/proof.bin",
      category: "artifact",
      skipPolicy: "required",
      blocking: true,
    })

    const [artifact] = await collectArtifactEvidence(root, [specification], {
      objectStore: store,
    })
    if (!artifact?.immutableRef) throw new Error("Passed artifact has no immutable ref")
    expect(artifact.status).toBe("passed")
    expect(artifact.immutableRef).toMatch(/^\.ralph\/runs\/run-artifact\/artifacts\/sha256\//)

    await unlink(resolve(root, "deliveries", "proof.bin"))
    expect(
      await readVerifiedContentReference(
        root,
        artifact.immutableRef,
        artifact.contentHash,
        artifact.sizeBytes,
      ),
    ).toEqual(Uint8Array.from([9, 8, 7, 0]))

    await writeFile(resolve(root, artifact.immutableRef), "corrupted")
    await expect(
      readVerifiedContentReference(
        root,
        artifact.immutableRef,
        artifact.contentHash,
        artifact.sizeBytes,
      ),
    ).rejects.toThrow(/hash mismatch|size mismatch/)
  })

  test("never retains secrets or files beyond bounds while inventory remains stack-agnostic", async () => {
    const root = await temporaryDirectory()
    const storeDirectory = resolve(root, ".ralph", "runs", "run-policy", "artifacts")
    await mkdir(resolve(root, "node_modules", "dependency"), { recursive: true })
    await writeFile(resolve(root, "safe.txt"), "safe")
    await writeFile(resolve(root, ".env.local"), "TOP_SECRET=never-retain")
    await writeFile(resolve(root, "large.bin"), "larger-than-four-bytes")
    await writeFile(resolve(root, "node_modules", "dependency", "index.js"), "do-not-scan")
    await writeFile(resolve(root, "zz-budget.txt"), "full")

    const before = await captureWorkspaceBaseline(root, {
      objectStore: { directory: storeDirectory },
      maxRetainedFileBytes: 4,
      maxTotalRetainedBytes: 4,
    })
    expect(before.files["safe.txt"]).toMatchObject({ retentionStatus: "retained" })
    expect(before.files["safe.txt"]?.contentRef).toBeString()
    expect(before.files[".env.local"]).toMatchObject({ retentionStatus: "sensitive" })
    expect(before.files["large.bin"]).toMatchObject({ retentionStatus: "per-file-limit" })
    expect(before.files["node_modules/dependency/index.js"]).toMatchObject({
      retentionStatus: "per-file-limit",
    })
    expect(before.files["zz-budget.txt"]).toMatchObject({ retentionStatus: "total-limit" })
    for (const path of [
      ".env.local",
      "large.bin",
      "node_modules/dependency/index.js",
      "zz-budget.txt",
    ]) {
      expect(before.files[path]?.contentRef).toBeUndefined()
    }
    const storedContent = await readAllUtf8Files(storeDirectory)
    expect(storedContent).toEqual(["safe"])
    expect(storedContent.join("\n")).not.toContain("TOP_SECRET")

    await writeFile(resolve(root, ".env.local"), "TOP_SECRET=changed")
    const after = await captureWorkspaceBaseline(root, {
      objectStore: { directory: storeDirectory },
      maxRetainedFileBytes: 4,
      maxTotalRetainedBytes: 4,
    })
    const changes = compareWorkspaceBaselines(before, after)
    expect(changes.modified).toContain(".env.local")
    await expect(verifyWorkspaceBaselineContent(root, before, changes.changed)).rejects.toThrow(
      "no immutable content reference",
    )
  })

  test("reserves retention for a later priority path after earlier files exhaust the budget", async () => {
    const root = await temporaryDirectory()
    const store = { directory: resolve(root, ".ralph", "runs", "run-priority", "artifacts") }
    await writeFile(resolve(root, "a-earlier.bin"), "aaaaaaaa")
    await writeFile(resolve(root, "b-earlier.bin"), "bbbbbbbb")
    await writeFile(resolve(root, "z-changed.txt"), "before!!")
    const captureOptions = {
      objectStore: store,
      maxRetainedFileBytes: 8,
      maxTotalRetainedBytes: 16,
      retentionPriorityPaths: ["z-changed.txt"],
    }

    const before = await captureWorkspaceBaseline(root, captureOptions)
    await writeFile(resolve(root, "z-changed.txt"), "after!!!")
    const after = await captureWorkspaceBaseline(root, captureOptions)
    const changes = compareWorkspaceBaselines(before, after)

    expect(changes.modified).toEqual(["z-changed.txt"])
    expect(before.files["z-changed.txt"]).toMatchObject({ retentionStatus: "retained" })
    expect(after.files["z-changed.txt"]).toMatchObject({ retentionStatus: "retained" })
    expect(before.files["b-earlier.bin"]).toMatchObject({ retentionStatus: "total-limit" })
    const beforeRef = before.files["z-changed.txt"]?.contentRef
    const afterRef = after.files["z-changed.txt"]?.contentRef
    if (!beforeRef || !afterRef) throw new Error("Priority delta did not retain both sides")
    expect(
      Buffer.from(
        await readVerifiedContentReference(
          root,
          beforeRef,
          before.files["z-changed.txt"]?.sha256 as string,
        ),
      ).toString(),
    ).toBe("before!!")
    expect(
      Buffer.from(
        await readVerifiedContentReference(
          root,
          afterRef,
          after.files["z-changed.txt"]?.sha256 as string,
        ),
      ).toString(),
    ).toBe("after!!!")
    await verifyWorkspaceBaselineContent(root, before, changes.changed)
    await verifyWorkspaceBaselineContent(root, after, changes.changed)
  })

  test("retains a smaller later delta without explicit priority after lexical files exhaust the budget", async () => {
    const root = await temporaryDirectory()
    const store = { directory: resolve(root, ".ralph", "runs", "run-size-priority", "artifacts") }
    await writeFile(resolve(root, "a-earlier.bin"), "aaaaaaaa")
    await writeFile(resolve(root, "b-earlier.bin"), "bbbbbbbb")
    await writeFile(resolve(root, "z-changed.txt"), "old!")
    const captureOptions = {
      objectStore: store,
      maxRetainedFileBytes: 8,
      maxTotalRetainedBytes: 16,
    }

    const before = await captureWorkspaceBaseline(root, captureOptions)
    await writeFile(resolve(root, "z-changed.txt"), "new!")
    const after = await captureWorkspaceBaseline(root, captureOptions)
    const changes = compareWorkspaceBaselines(before, after)

    expect(changes.modified).toEqual(["z-changed.txt"])
    expect(before.files["z-changed.txt"]?.contentRef).toBeString()
    expect(after.files["z-changed.txt"]?.contentRef).toBeString()
    expect(before.files["b-earlier.bin"]).toMatchObject({ retentionStatus: "total-limit" })
    await verifyWorkspaceBaselineContent(root, before, changes.changed)
    await verifyWorkspaceBaselineContent(root, after, changes.changed)
  })

  test("streams a changed file above one MiB when configured retention limits allow it", async () => {
    const root = await temporaryDirectory()
    const store = { directory: resolve(root, ".ralph", "runs", "run-large-delta", "artifacts") }
    const size = 1_048_576 + 65_536
    const beforeBytes = new Uint8Array(size).fill(0x61)
    const afterBytes = new Uint8Array(size).fill(0x62)
    const target = resolve(root, "large-changed.bin")
    const captureOptions = {
      objectStore: store,
      maxRetainedFileBytes: size,
      maxTotalRetainedBytes: size,
      retentionPriorityPaths: ["large-changed.bin"],
    }

    await writeFile(target, beforeBytes)
    const before = await captureWorkspaceBaseline(root, captureOptions)
    await writeFile(target, afterBytes)
    const after = await captureWorkspaceBaseline(root, captureOptions)
    const changes = compareWorkspaceBaselines(before, after)

    expect(changes.modified).toEqual(["large-changed.bin"])
    expect(before.files["large-changed.bin"]?.contentRef).toBeString()
    expect(after.files["large-changed.bin"]?.contentRef).toBeString()
    await verifyWorkspaceBaselineContent(root, before, changes.changed)
    await verifyWorkspaceBaselineContent(root, after, changes.changed)
  })

  test("inventories and retains stack-specific output directories without hardcoded exclusions", async () => {
    const root = await temporaryDirectory()
    const store = { directory: resolve(root, ".ralph", "runs", "run-stacks", "artifacts") }
    for (const [path, content] of [
      ["dist/app.js", "javascript-output"],
      ["build/app.bin", "native-output"],
      ["target/result.txt", "rust-output"],
    ] as const) {
      await mkdir(resolve(root, path, ".."), { recursive: true })
      await writeFile(resolve(root, path), content)
    }

    const baseline = await captureWorkspaceBaseline(root, {
      objectStore: store,
      maxRetainedFileBytes: 1_024,
      maxTotalRetainedBytes: 4_096,
    })

    for (const path of ["dist/app.js", "build/app.bin", "target/result.txt"]) {
      expect(baseline.files[path]).toMatchObject({ retentionStatus: "retained" })
      expect(baseline.files[path]?.contentRef).toMatch(
        /^\.ralph\/runs\/run-stacks\/artifacts\/sha256\//,
      )
    }
  })

  test("hashes selected Git control facts without retaining their content", async () => {
    const root = await temporaryDirectory()
    const storeDirectory = resolve(root, ".ralph", "runs", "run-git-control", "artifacts")
    await mkdir(resolve(root, ".git", "hooks"), { recursive: true })
    await mkdir(resolve(root, ".git", "refs", "heads"), { recursive: true })
    await writeFile(resolve(root, ".git", "config"), "credential = should-not-be-retained")
    await writeFile(resolve(root, ".git", "HEAD"), "ref: refs/heads/main\n")
    await writeFile(resolve(root, ".git", "index"), "fake-index")
    await writeFile(resolve(root, ".git", "packed-refs"), "# pack-refs\n")
    await writeFile(resolve(root, ".git", "refs", "heads", "main"), "a".repeat(40))
    await writeFile(resolve(root, ".git", "hooks", "pre-commit"), "first hook")
    await writeFile(resolve(root, "safe.txt"), "retained workspace content")

    const before = await captureWorkspaceBaseline(root, {
      objectStore: { directory: storeDirectory },
    })
    for (const path of [
      ".git/config",
      ".git/HEAD",
      ".git/index",
      ".git/packed-refs",
      ".git/refs/heads/main",
      ".git/hooks/pre-commit",
    ]) {
      expect(before.files[path]).toMatchObject({ retentionStatus: "control-plane" })
      expect(before.files[path]?.contentRef).toBeUndefined()
    }
    expect((await readAllUtf8Files(storeDirectory)).join("\n")).not.toContain("credential")

    await writeFile(resolve(root, ".git", "config"), "credential = changed")
    await writeFile(resolve(root, ".git", "hooks", "pre-commit"), "second hook")
    const after = await captureWorkspaceBaseline(root, {
      objectStore: { directory: storeDirectory },
    })
    const changes = compareWorkspaceBaselines(before, after)
    expect(changes.modified).toEqual([".git/config", ".git/hooks/pre-commit"])
    await expect(verifyWorkspaceBaselineContent(root, after, changes.changed)).rejects.toThrow(
      "no immutable content reference",
    )
  })

  test("treats Git branch and status facts as control-plane deltas with unchanged worktree files", async () => {
    const root = await temporaryDirectory()
    await writeFile(resolve(root, "safe.txt"), "same worktree bytes\n")
    await runGit(root, ["init"])
    await runGit(root, ["config", "user.email", "ralph-test@example.invalid"])
    await runGit(root, ["config", "user.name", "Ralph Test"])
    await runGit(root, ["config", "core.autocrlf", "false"])
    await runGit(root, ["add", "safe.txt"])
    await runGit(root, ["commit", "-m", "baseline"])

    const beforeBranch = await captureWorkspaceBaseline(root)
    await writeFile(resolve(root, "safe.txt"), "ordinary executor change\n")
    const afterContent = await captureWorkspaceBaseline(root)
    const contentChanges = compareWorkspaceBaselines(beforeBranch, afterContent)
    expect(contentChanges.modified).toContain("safe.txt")
    expect(contentChanges.changed).not.toContain(".git/ralph-observed/status")
    await writeFile(resolve(root, "safe.txt"), "same worktree bytes\n")

    await runGit(root, ["checkout", "-b", "evidence-control-change"])
    const afterBranch = await captureWorkspaceBaseline(root)
    const branchChanges = compareWorkspaceBaselines(beforeBranch, afterBranch)
    expect(branchChanges.changed).toContain(".git/ralph-observed/branch")
    expect(branchChanges.changed).toContain(".git/HEAD")
    expect(branchChanges.changed.every((path) => path.startsWith(".git/"))).toBeTrue()

    const beforeIndex = afterBranch
    await writeFile(resolve(root, "safe.txt"), "staged bytes\n")
    await runGit(root, ["add", "safe.txt"])
    await writeFile(resolve(root, "safe.txt"), "same worktree bytes\n")
    const afterIndex = await captureWorkspaceBaseline(root)
    const indexChanges = compareWorkspaceBaselines(beforeIndex, afterIndex)
    expect(indexChanges.changed).toContain(".git/index")
    expect(indexChanges.changed).toContain(".git/ralph-observed/status")
    expect(indexChanges.changed.every((path) => path.startsWith(".git/"))).toBeTrue()
  })

  test("follows a worktree gitfile and hashes external gitdir facts without retaining bytes", async () => {
    const root = await temporaryDirectory()
    const external = await temporaryDirectory()
    const worktreeGitDirectory = resolve(external, "worktree")
    const commonGitDirectory = resolve(external, "common")
    await mkdir(resolve(commonGitDirectory, "refs", "heads"), { recursive: true })
    await mkdir(resolve(commonGitDirectory, "refs", "heads", "ralph", "run-a"), {
      recursive: true,
    })
    await mkdir(resolve(commonGitDirectory, "hooks"), { recursive: true })
    await mkdir(worktreeGitDirectory, { recursive: true })
    await writeFile(resolve(root, "safe.txt"), "unchanged\n")
    await writeFile(resolve(root, ".git"), `gitdir: ${worktreeGitDirectory}\n`)
    await writeFile(resolve(worktreeGitDirectory, "commondir"), "../common\n")
    await writeFile(resolve(worktreeGitDirectory, "HEAD"), "ref: refs/heads/main\n")
    await writeFile(resolve(worktreeGitDirectory, "index"), "first index")
    await writeFile(resolve(commonGitDirectory, "config"), "[core]\n\tbare = false\n")
    await writeFile(resolve(commonGitDirectory, "refs", "heads", "main"), "a".repeat(40))
    await writeFile(
      resolve(commonGitDirectory, "refs", "heads", "ralph", "run-a", "attempt-a"),
      "c".repeat(40),
    )
    await writeFile(resolve(commonGitDirectory, "hooks", "pre-commit"), "first hook")

    const before = await captureWorkspaceBaseline(root, {
      objectStore: { directory: resolve(root, ".ralph", "runs", "run-gitfile", "artifacts") },
    })
    expect(before.files[".git/common/refs/heads/ralph/run-a/attempt-a"]).toBeUndefined()
    await writeFile(resolve(worktreeGitDirectory, "HEAD"), "ref: refs/heads/other\n")
    await writeFile(
      resolve(commonGitDirectory, "refs", "heads", "ralph", "run-a", "attempt-a"),
      "d".repeat(40),
    )
    await writeFile(resolve(commonGitDirectory, "hooks", "pre-commit"), "second hook")
    const after = await captureWorkspaceBaseline(root, {
      objectStore: { directory: resolve(root, ".ralph", "runs", "run-gitfile", "artifacts") },
    })
    const changes = compareWorkspaceBaselines(before, after)

    expect(changes.modified).toEqual([".git/common/hooks/pre-commit", ".git/worktree/HEAD"])
    expect(changes.hasChanges).toBeTrue()
    expect(after.files[".git/common/hooks/pre-commit"]).toMatchObject({
      retentionStatus: "control-plane",
    })
    expect(after.files[".git/common/hooks/pre-commit"]?.contentRef).toBeUndefined()
    await expect(verifyWorkspaceBaselineContent(root, after, changes.changed)).rejects.toThrow(
      "no immutable content reference",
    )
  })

  test("rejects sensitive and oversized declared artifacts instead of archiving them", async () => {
    const root = await temporaryDirectory()
    const store = { directory: resolve(root, ".ralph", "runs", "run-artifact-policy", "artifacts") }
    await writeFile(resolve(root, ".env"), "TOKEN=secret")
    await writeFile(resolve(root, "large-proof.bin"), "12345")
    const specifications = [
      VerificationSpecSchema.parse({
        id: "sensitive-artifact",
        type: "artifact",
        artifactId: "sensitive",
        path: ".env",
        category: "artifact",
        skipPolicy: "required",
        blocking: true,
      }),
      VerificationSpecSchema.parse({
        id: "large-artifact",
        type: "artifact",
        artifactId: "large",
        path: "large-proof.bin",
        category: "artifact",
        skipPolicy: "required",
        blocking: true,
      }),
    ]
    const artifacts = await collectArtifactEvidence(root, specifications, {
      objectStore: store,
      maxArtifactBytes: 4,
    })
    expect(artifacts).toHaveLength(2)
    expect(artifacts.every((artifact) => artifact.status === "failed")).toBeTrue()
    expect(artifacts.every((artifact) => artifact.immutableRef === undefined)).toBeTrue()
    expect(artifacts.map((artifact) => artifact.reason).join("\n")).toMatch(
      /sensitive|retention limit/,
    )
  })
})

describe("structured command gates", () => {
  test("preserves argv boundaries, resolves explicit env refs and redacts captured secrets", async () => {
    const root = await temporaryDirectory()
    const spec = CommandSpecSchema.parse({
      executable: process.execPath,
      args: [
        "-e",
        "console.log(JSON.stringify(process.argv.slice(1))); console.error(process.env.GATE_TOKEN)",
        "argument with spaces",
      ],
      environmentRefs: { GATE_TOKEN: "env:SOURCE_GATE_TOKEN" },
      timeoutMs: 5_000,
      successExitCodes: [0],
      outputLimitBytes: 10_000,
    })
    const result = await runStructuredCommand(spec, {
      workspaceRoot: root,
      environment: { ...process.env, SOURCE_GATE_TOKEN: "secret-gate-value" },
      environmentRoot: resolve(root, ".gate-environment"),
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("argument with spaces")
    expect(result.stderr).toContain("[REDACTED]")
    expect(`${result.stdout}${result.stderr}`).not.toContain("secret-gate-value")
    expect(result.timedOut).toBeFalse()
  })

  test("returns timeout and bounded-output facts without treating them as pass", async () => {
    const root = await temporaryDirectory()
    const boundedSpec = CommandSpecSchema.parse({
      executable: process.execPath,
      args: ["-e", "console.log('x'.repeat(1000))"],
      timeoutMs: 5_000,
      successExitCodes: [0],
      outputLimitBytes: 32,
    })
    const bounded = await runStructuredCommand(boundedSpec, { workspaceRoot: root })
    expect(bounded.truncated).toBeTrue()
    expect(Buffer.byteLength(bounded.stdout)).toBeLessThanOrEqual(32)
    expect(Buffer.byteLength(bounded.rawStdout)).toBeGreaterThan(32)
    expect(bounded.rawTruncated).toBeFalse()

    const persisted: Array<{ stream: string; value: string }> = []
    const boundedGate = await runVerification(
      VerificationSpecSchema.parse({
        id: "bounded-raw-output",
        type: "command",
        category: "command",
        skipPolicy: "required",
        blocking: true,
        command: boundedSpec,
      }),
      {
        workspaceRoot: root,
        persistOutput: async (_gateId, stream, value) => {
          persisted.push({ stream, value })
          return `raw/${stream}.txt`
        },
      },
    )
    expect(boundedGate).toMatchObject({
      status: "passed",
      stdoutBytes: bounded.stdoutBytes,
      stderrBytes: 0,
      outputTruncated: true,
      rawOutputTruncated: false,
      outputRefs: ["raw/stdout.txt"],
    })
    expect(gateResultFromVerification(boundedGate)).toMatchObject({
      stdoutBytes: bounded.stdoutBytes,
      stderrBytes: 0,
      outputTruncated: true,
      rawOutputTruncated: false,
    })
    expect(Buffer.byteLength(persisted[0]?.value ?? "")).toBeGreaterThan(32)

    const timeoutSpec = CommandSpecSchema.parse({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 50,
      successExitCodes: [0],
      outputLimitBytes: 32,
    })
    const timedOut = await runStructuredCommand(timeoutSpec, { workspaceRoot: root })

    expect(timedOut.timedOut).toBeTrue()
  })

  test("caps raw evidence explicitly and redacts a secret split at the capture boundary", async () => {
    const root = await temporaryDirectory()
    const secret = "super-secret-value"
    const spec = CommandSpecSchema.parse({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('abc' + process.env.GATE_TOKEN)"],
      environmentRefs: { GATE_TOKEN: "env:SOURCE_GATE_TOKEN" },
      timeoutMs: 5_000,
      successExitCodes: [0],
      outputLimitBytes: 4,
    })
    const result = await runStructuredCommand(spec, {
      workspaceRoot: root,
      environment: { ...process.env, SOURCE_GATE_TOKEN: secret },
      rawOutputLimitBytes: 8,
    })

    expect(result).toMatchObject({ truncated: true, rawTruncated: true })
    expect(result.stdout).toContain("[REDACTED]")
    expect(result.rawStdout).toContain("[REDACTED]")
    expect(`${result.stdout}${result.rawStdout}`).not.toContain("super")
  })

  test("materializes invalid cwd and missing environment refs as structured gate errors", async () => {
    const root = await temporaryDirectory()
    for (const command of [
      CommandSpecSchema.parse({
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: "does-not-exist",
        timeoutMs: 5_000,
        successExitCodes: [0],
        outputLimitBytes: 1_024,
      }),
      CommandSpecSchema.parse({
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        environmentRefs: { REQUIRED_TOKEN: "env:RALPH_TEST_MISSING_ENV_REF" },
        timeoutMs: 5_000,
        successExitCodes: [0],
        outputLimitBytes: 1_024,
      }),
    ]) {
      const specification = VerificationSpecSchema.parse({
        id: `command-error-${command.cwd ?? "env"}`,
        type: "command",
        category: "command",
        skipPolicy: "required",
        blocking: true,
        command,
      })
      const result = await runVerification(specification, {
        workspaceRoot: root,
        environment: {},
      })
      expect(result.status).toBe("error")
      expect(result.blocking).toBeTrue()
      expect(result.reason).toBeString()
    }
  })
})
