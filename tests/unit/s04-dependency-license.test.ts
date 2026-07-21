import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { parse as parseYaml } from "yaml"

const ROOT = resolve(import.meta.dir, "../..")
const S04_PACKAGES = ["commands", "credentials", "openai-driver", "providers"] as const
const ALLOWED_DIRECT: Record<(typeof S04_PACKAGES)[number], Record<string, string>> = {
  commands: {
    "@ralph/credentials": "workspace:*",
    "@ralph/domain": "workspace:*",
    "@ralph/distribution": "workspace:*",
    "@ralph/openai-driver": "workspace:*",
    "@ralph/orchestration": "workspace:*",
    "@ralph/persistence": "workspace:*",
    "@ralph/prd": "workspace:*",
    "@ralph/providers": "workspace:*",
    "@ralph/telemetry": "workspace:*",
    yaml: "2.9.0",
  },
  credentials: { zod: "4.4.3" },
  "openai-driver": {},
  providers: { zod: "4.4.3" },
}

type Manifest = {
  name: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

async function manifest(path: string): Promise<Manifest> {
  return JSON.parse(await readFile(resolve(ROOT, path), "utf8")) as Manifest
}

describe("S04 dependency and license gate", () => {
  test("keeps provider, auth and driver dependencies on a closed allowlist", async () => {
    for (const packageName of S04_PACKAGES) {
      const value = await manifest(`packages/${packageName}/package.json`)
      expect(value.dependencies ?? {}, value.name).toEqual(ALLOWED_DIRECT[packageName])
      expect(value.devDependencies ?? {}, value.name).toEqual({})
    }
  })

  test("pins the adapted-layer runtime closure and integrity in bun.lock", async () => {
    const lock = parseYaml(await readFile(resolve(ROOT, "bun.lock"), "utf8")) as {
      workspaces: Record<string, { dependencies?: Record<string, string> }>
      packages: Record<string, unknown>
    }
    for (const packageName of S04_PACKAGES) {
      expect(lock.workspaces[`packages/${packageName}`]?.dependencies ?? {}).toEqual(
        ALLOWED_DIRECT[packageName],
      )
    }
    expect(lock.packages.zod).toEqual([
      "zod@4.4.3",
      "",
      {},
      "sha512-ytENFjIJFl2UwYglde2jchW2Hwm4GJFLDiSXWdTrJQBIN9Fcyp7n4DhxJEiWNAJMV1/BqWfW/kkg71UDcHJyTQ==",
    ])
    expect(lock.packages.yaml).toEqual([
      "yaml@2.9.0",
      "",
      { bin: { yaml: "bin.mjs" } },
      "sha512-2AvhNX3mb8zd6Zy7INTtSpl1F15HW6Wnqj0srWlkKLcpYl/gMIMJiyuGq2KeI2YFxUPjdlB+3Lc10seMLtL4cA==",
    ])

    const zod = await manifest("node_modules/zod/package.json")
    expect(zod.dependencies ?? {}).toEqual({})
    expect(zod.optionalDependencies ?? {}).toEqual({})
  })

  test("verifies external S04 runtime dependencies and the derived-source notice", async () => {
    const zod = await manifest("node_modules/zod/package.json")
    expect(zod).toMatchObject({ name: "zod" })
    expect((zod as Manifest & { version?: string }).version).toBe("4.4.3")
    expect((zod as Manifest & { license?: string }).license).toBe("MIT")

    const yaml = await manifest("node_modules/yaml/package.json")
    expect(yaml).toMatchObject({ name: "yaml" })
    expect((yaml as Manifest & { version?: string }).version).toBe("2.9.0")
    expect((yaml as Manifest & { license?: string }).license).toBe("ISC")
    expect(yaml.dependencies ?? {}).toEqual({})
    expect(yaml.optionalDependencies ?? {}).toEqual({})

    const notice = await readFile(resolve(ROOT, "THIRD_PARTY_NOTICES.md"), "utf8")
    const upstreamLicense = await readFile(resolve(ROOT, "third_party/opencode/LICENSE"), "utf8")
    expect(notice).toContain("Fixed commit: `45cd8d76920839e4a7b6b931c4e26b52e1495636`")
    expect(notice).toContain("License: MIT")
    expect(upstreamLicense).toStartWith("MIT License")
  })

  test("does not inherit OpenCode, AI SDK or dynamic provider packages", async () => {
    const forbidden = ["opencode", "@opencode-ai/", "@ai-sdk/", "effect", "fuzzysort", "remeda"]
    for (const packageName of S04_PACKAGES) {
      const raw = await readFile(resolve(ROOT, `packages/${packageName}/package.json`), "utf8")
      for (const dependency of forbidden) {
        expect(raw, `${packageName}:${dependency}`).not.toContain(`"${dependency}`)
      }
    }
  })
})
