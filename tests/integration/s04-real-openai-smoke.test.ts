import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CachedModelCatalog,
  createCuratedCatalogSource,
  InMemoryModelCatalogCache,
} from "@ralph/providers"
import {
  createS04Services,
  isRealS04SmokeOptedIn,
  rawSmokePath,
} from "../../apps/ralph-cli/src/s04-services"

const enabled = isRealS04SmokeOptedIn(process.env)
const realTest = enabled ? test : test.skip

realTest(
  "REAL OPT-IN S04: OpenAI environment credential read-only smoke",
  async () => {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        "RALPH_S04_REAL_PROVIDER_SMOKE=1 requires OPENAI_API_KEY; the key is referenced, never copied to config",
      )
    }
    const dataRoot = await mkdtemp(join(tmpdir(), "ralph-s04-real-openai-"))
    try {
      const catalog = new CachedModelCatalog({
        source: createCuratedCatalogSource(),
        cache: new InMemoryModelCatalogCache(),
        ttlMs: 24 * 60 * 60 * 1_000,
      })
      const services = createS04Services({
        dataRoot,
        environment: process.env,
        catalogFactory: () => catalog,
      })
      const catalogHandle = await services.credentials.catalogSnapshot()
      const providerInfo = catalogHandle.resolution.snapshot.providers.find(
        (provider) => provider.id === "openai",
      )
      if (!providerInfo) throw new Error("OpenAI is missing from the opt-in catalog snapshot")
      await services.credentials.connect({
        provider: "openai",
        providerInfo,
        catalogHandle,
        method: "environment",
        credentialId: "real-openai-env",
        label: "Real opt-in OpenAI smoke",
        nonInteractive: true,
        headless: true,
        environmentName: "OPENAI_API_KEY",
        secretSource: "not-applicable",
        allowInsecureStore: false,
      })
      const model = process.env.RALPH_S04_REAL_OPENAI_MODEL ?? "gpt-5.4-mini"
      const result = await services.modelSmoke.smoke({
        provider: "openai",
        model,
        credentialId: "real-openai-env",
        parameters: {},
        requirements: {
          input: ["text"],
          tools: false,
          toolStreaming: false,
          reasoning: false,
          structuredOutput: false,
          usage: [],
          access: [],
        },
        prompt:
          "Reply with exactly RALPH_SMOKE_OK. Do not call tools and do not perform side effects.",
        tools: [],
        readOnly: true,
        refreshCatalog: false,
        timeoutMs: 60_000,
        telemetry: {
          persist_raw_output: true,
          event_retention: null,
          redact: true,
        },
        diagnosticScope: dataRoot,
      })
      expect(result.finishReason).toBeTruthy()
      expect(result.rawRef).toMatch(/^raw:\/\/model-smoke\/[a-f0-9]{64}\/[a-f0-9]{64}$/)
      const raw = await readFile(rawSmokePath(services.paths.rawSmoke, result.rawRef ?? ""), "utf8")
      expect(raw).not.toContain(process.env.OPENAI_API_KEY)
    } finally {
      await rm(dataRoot, { recursive: true, force: true })
    }
  },
  90_000,
)
