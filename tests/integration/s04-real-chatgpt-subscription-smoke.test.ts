import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import type { CredentialRef } from "@ralph/credentials"
import {
  CachedModelCatalog,
  createCuratedCatalogSource,
  InMemoryModelCatalogCache,
} from "@ralph/providers"
import {
  type AuthorizationNotice,
  createS04Services,
  rawSmokePath,
} from "../../apps/ralph-cli/src/s04-services"

const OPT_IN = "RALPH_S04_REAL_CHATGPT_SMOKE"
const enabled = process.env[OPT_IN] === "1"
const realTest = enabled ? test : test.skip
const DEVICE_AUTH_TIMEOUT_MS = 15 * 60 * 1_000
const MODEL_SMOKE_TIMEOUT_MS = 90_000
const TEST_TIMEOUT_MS = DEVICE_AUTH_TIMEOUT_MS + MODEL_SMOKE_TIMEOUT_MS + 60_000
const TEMP_PREFIX = "ralph-s04-real-chatgpt-"

function terminalSafe(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint >= 0x20 && (codePoint < 0x7f || codePoint > 0x9f)
    })
    .join("")
    .slice(0, 2_048)
}

function showDeviceAuthorization(notice: AuthorizationNotice): void {
  if (notice.kind !== "device" || !notice.userCode) {
    throw new Error("The real ChatGPT harness requires a device-code authorization notice")
  }
  process.stderr.write(
    `${[
      "[REAL OPT-IN] Complete ChatGPT Plus/Pro device authorization:",
      `URL: ${terminalSafe(notice.url)}`,
      `Code: ${terminalSafe(notice.userCode)}`,
      terminalSafe(notice.instructions),
    ].join("\n")}\n`,
  )
}

async function removeExactHarnessDirectory(dataRoot: string): Promise<void> {
  const expectedParent = resolve(tmpdir())
  const exactTarget = resolve(dataRoot)
  const info = await lstat(exactTarget)
  if (
    resolve(dirname(exactTarget)) !== expectedParent ||
    !basename(exactTarget).startsWith(TEMP_PREFIX) ||
    !info.isDirectory() ||
    info.isSymbolicLink()
  ) {
    throw new Error("Refusing to remove a path outside the exact ChatGPT smoke temp directory")
  }
  await rm(exactTarget, { recursive: true })
}

realTest(
  "REAL OPT-IN S04: ChatGPT Plus/Pro device-code and read-only model smoke",
  async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), TEMP_PREFIX))
    const credentialId = `real-chatgpt-${randomUUID()}`
    const model = process.env.RALPH_S04_REAL_CHATGPT_MODEL ?? "gpt-5.4-mini"
    const catalog = new CachedModelCatalog({
      source: createCuratedCatalogSource(),
      cache: new InMemoryModelCatalogCache(),
      ttlMs: 24 * 60 * 60 * 1_000,
    })
    const services = createS04Services({
      dataRoot,
      // The account token is acquired only by the embedded device flow and is
      // stored in the OS keychain. This harness accepts no token from env/argv/config.
      environment: {},
      catalogFactory: () => catalog,
      onAuthorization: showDeviceAuthorization,
    })
    let credential: CredentialRef | undefined

    try {
      process.stderr.write(
        `[REAL OPT-IN] Cleanup scope: ${dataRoot}\n[REAL OPT-IN] Local credential ID: ${credentialId}\n`,
      )
      const selected = await catalog.inspect({ provider: "openai", model })
      expect(selected?.access).toContain("subscription")
      const catalogHandle = await services.credentials.catalogSnapshot()
      const providerInfo = catalogHandle.resolution.snapshot.providers.find(
        (provider) => provider.id === "openai",
      )
      if (!providerInfo) throw new Error("OpenAI is missing from the opt-in catalog snapshot")

      credential = await services.credentials.connect({
        provider: "openai",
        providerInfo,
        catalogHandle,
        method: "device-code",
        credentialId,
        label: "Real opt-in ChatGPT Plus/Pro smoke",
        nonInteractive: false,
        headless: true,
        timeoutMs: DEVICE_AUTH_TIMEOUT_MS,
        secretSource: "not-applicable",
        allowInsecureStore: false,
      })
      expect(credential.store).toBe("os-keychain")
      expect(credential.method).toBe("device-code")

      const result = await services.modelSmoke.smoke({
        provider: "openai",
        model,
        credentialId,
        parameters: {},
        requirements: {
          input: ["text"],
          tools: false,
          toolStreaming: false,
          reasoning: false,
          structuredOutput: false,
          usage: [],
          access: ["subscription"],
        },
        prompt:
          "Reply with exactly RALPH_SMOKE_OK. Do not call tools and do not perform side effects.",
        tools: [],
        readOnly: true,
        refreshCatalog: false,
        timeoutMs: MODEL_SMOKE_TIMEOUT_MS,
        telemetry: {
          persist_raw_output: true,
          event_retention: null,
          redact: true,
        },
        diagnosticScope: dataRoot,
      })
      expect(result.text?.trim()).toBe("RALPH_SMOKE_OK")
      expect(result.finishReason).toBeTruthy()
      expect(result.rawRef).toMatch(/^raw:\/\/model-smoke\/[a-f0-9]{64}\/[a-f0-9]{64}$/)
      expect(result.catalogSnapshotId).toMatch(/^catalog:[a-f0-9]{64}$/)

      const raw = await readFile(rawSmokePath(services.paths.rawSmoke, result.rawRef ?? ""), "utf8")
      expect(raw).not.toMatch(/"(?:access|refresh|id)[_-]?token"\s*:/i)
    } finally {
      try {
        if (credential) {
          await services.credentials.revoke(credential)
        }
      } finally {
        await removeExactHarnessDirectory(dataRoot)
      }
    }
  },
  TEST_TIMEOUT_MS,
)
