import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  type CredentialConnectCommandRequest,
  type ModelSmokeCommandRequest,
  ROLE_PROFILE_FORM_METADATA,
  roleProfileFormMetadata,
} from "@ralph/commands"
import { FakeSecretStore, secretInputFromValue } from "@ralph/credentials"
import { type ChatGptCredential, type FetchLike, OpenAiDriverError } from "@ralph/openai-driver"
import {
  CachedModelCatalog,
  CatalogResolutionSchema,
  createCuratedCatalogSource,
  InMemoryModelCatalogCache,
  type ModelCatalog,
  ProviderEventSchema,
  TokenUsageSchema,
} from "@ralph/providers"
import {
  createTerminalProfileForm,
  type TerminalProfilePrompt,
} from "../../apps/ralph-cli/src/profile-form"
import {
  type ChatGptAccountConnectRequest,
  type ChatGptAccountFlow,
  chatGptLoopbackCallbackFactory,
  createS04Services,
  ModelSmokeFailure,
  OpenAiChatGptAccountFlow,
  rawSmokePath,
} from "../../apps/ralph-cli/src/s04-services"

const NOW = Date.parse("2026-07-18T15:00:00.000Z")
const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function temporaryDirectory(): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(await realpath(tmpdir()), "ralph-s04-services-")),
  )
  temporaryDirectories.push(directory)
  return directory
}

function offlineCatalog(): ModelCatalog {
  return new CachedModelCatalog({
    source: createCuratedCatalogSource(),
    cache: new InMemoryModelCatalogCache(),
    ttlMs: 24 * 60 * 60 * 1_000,
    clock: () => new Date(NOW),
  })
}

class FakeAccountFlow implements ChatGptAccountFlow {
  connectRequests: ChatGptAccountConnectRequest[] = []
  refreshes = 0
  revocations = 0

  constructor(
    private readonly initial: ChatGptCredential,
    private readonly renewed: ChatGptCredential,
  ) {}

  async connect(request: ChatGptAccountConnectRequest): Promise<ChatGptCredential> {
    this.connectRequests.push(request)
    return { ...this.initial }
  }

  async refresh(_credential: ChatGptCredential): Promise<ChatGptCredential> {
    this.refreshes += 1
    return { ...this.renewed }
  }

  async revoke(_credential: ChatGptCredential): Promise<void> {
    this.revocations += 1
  }
}

function inertAccountFlow(): FakeAccountFlow {
  return new FakeAccountFlow(
    {
      kind: "chatgpt-subscription",
      accessToken: "unused-access-token",
      refreshToken: "unused-refresh-token",
      expiresAt: NOW + 3_600_000,
    },
    {
      kind: "chatgpt-subscription",
      accessToken: "unused-renewed-access-token",
      refreshToken: "unused-renewed-refresh-token",
      expiresAt: NOW + 7_200_000,
    },
  )
}

function jsonModelResponse(outputText: string, usage = true): Response {
  return new Response(
    JSON.stringify({
      output_text: outputText,
      ...(usage
        ? {
            usage: {
              input_tokens: 10,
              output_tokens: 4,
              total_tokens: 14,
              output_tokens_details: { reasoning_tokens: 2 },
            },
          }
        : {}),
      status: "completed",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

function sseModelResponse(events: readonly Record<string, unknown>[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`
}

function deterministicOAuthRandom(size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, index) => (size + index * 17) % 256)
}

function apiConnectRequest(provider: string, credentialId: string) {
  return {
    provider,
    method: "api-key" as const,
    credentialId,
    label: `${provider} test key`,
    nonInteractive: true,
    headless: true,
    secretSource: "stdin" as const,
    allowInsecureStore: false,
  }
}

async function trustedProvider(services: ReturnType<typeof createS04Services>, providerId: string) {
  const catalogHandle = await services.credentials.catalogSnapshot()
  const providerInfo = catalogHandle.resolution.snapshot.providers.find(
    (candidate) => candidate.id === providerId,
  )
  if (!providerInfo) throw new Error(`Missing fixture provider ${providerId}`)
  return { catalogHandle, providerInfo }
}

async function trustedConnectRequest(
  services: ReturnType<typeof createS04Services>,
  request: Omit<CredentialConnectCommandRequest, "providerInfo" | "catalogHandle">,
): Promise<CredentialConnectCommandRequest> {
  return { ...request, ...(await trustedProvider(services, request.provider)) }
}

function smokeRequest(credentialId: string, model = "gpt-5.4-mini"): ModelSmokeCommandRequest {
  return {
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
      access: [],
    },
    prompt: "Reply with exactly RALPH_SMOKE_OK. Do not call tools and do not perform side effects.",
    tools: [] as const,
    readOnly: true as const,
    refreshCatalog: false,
    telemetry: {
      persist_raw_output: true,
      event_retention: null,
      redact: true,
    },
    diagnosticScope: process.cwd(),
  }
}

describe("S04 concrete credential composition", () => {
  test("binds the callback to loopback while advertising the pinned localhost redirect", async () => {
    const callback = await chatGptLoopbackCallbackFactory({
      host: "127.0.0.1",
      port: 0,
      path: "/auth/callback",
      expectedState: "state-with-sufficient-test-entropy",
    })
    try {
      const redirect = new URL(callback.redirectUri)
      expect(redirect.hostname).toBe("localhost")
      expect(redirect.pathname).toBe("/auth/callback")
      expect(Number(redirect.port)).toBeGreaterThan(0)
    } finally {
      await callback.close()
    }
  })

  test("rejects missing or forged catalog capabilities before any provider flow", async () => {
    const dataRoot = await temporaryDirectory()
    const keychain = new FakeSecretStore()
    const catalogBase = offlineCatalog()
    const counts = { snapshotCalls: 0, providerListCalls: 0 }
    const catalog: ModelCatalog = {
      snapshot: (options) => {
        counts.snapshotCalls += 1
        return catalogBase.snapshot(options)
      },
      providers: (options) => {
        counts.providerListCalls += 1
        return catalogBase.providers(options)
      },
      models: (query, options) => catalogBase.models(query, options),
      inspect: (reference, options) => catalogBase.inspect(reference, options),
    }
    const accountFlow = inertAccountFlow()
    const services = createS04Services({
      dataRoot,
      environment: {},
      catalogFactory: () => catalog,
      keychainStore: keychain,
      accountFlow,
      readSecretStdin: async () => secretInputFromValue("boundary-api-key"),
      now: () => NOW,
    })
    const rejection = async (operation: Promise<unknown>): Promise<unknown> =>
      operation.then(
        () => new Error("Expected credential boundary rejection"),
        (error: unknown) => error,
      )

    const externalResolution = await catalogBase.snapshot()
    const externalOpenAi = externalResolution.snapshot.providers.find(
      (provider) => provider.id === "openai",
    )
    if (!externalOpenAi) throw new Error("Missing external OpenAI fixture")
    const missingHandle = await rejection(
      services.credentials.connect({
        ...apiConnectRequest("openai", "missing-handle"),
        providerInfo: externalOpenAi,
      }),
    )
    expect(missingHandle).toMatchObject({ code: "RALPH_CREDENTIAL_CATALOG_HANDLE_REQUIRED" })

    const forgedHandle = { resolution: externalResolution }
    const foreignHandle = await rejection(
      services.credentials.connect({
        ...apiConnectRequest("openai", "foreign-handle"),
        providerInfo: externalOpenAi,
        catalogHandle: forgedHandle,
      }),
    )
    expect(foreignHandle).toMatchObject({ code: "RALPH_CREDENTIAL_CATALOG_HANDLE_UNTRUSTED" })
    expect(counts).toEqual({ snapshotCalls: 0, providerListCalls: 0 })

    const catalogHandle = await services.credentials.catalogSnapshot()
    const openai = catalogHandle.resolution.snapshot.providers.find(
      (provider) => provider.id === "openai",
    )
    const anthropic = catalogHandle.resolution.snapshot.providers.find(
      (provider) => provider.id === "anthropic",
    )
    if (!openai || !anthropic) throw new Error("Missing trusted provider fixtures")
    expect(Object.isFrozen(catalogHandle.resolution)).toBe(true)
    expect(Object.isFrozen(openai)).toBe(true)
    expect(Object.isFrozen(openai.credentialMethods)).toBe(true)

    const missingProvider = await rejection(
      services.credentials.connect({
        ...apiConnectRequest("openai", "missing-provider"),
        catalogHandle,
        providerInfo: undefined,
      } as unknown as CredentialConnectCommandRequest),
    )
    expect(missingProvider).toMatchObject({ code: "RALPH_CREDENTIAL_PROVIDER_REQUIRED" })

    const clonedOpenAi = structuredClone(openai)
    const forgedProvider = await rejection(
      services.credentials.connect({
        ...apiConnectRequest("openai", "forged-provider"),
        providerInfo: clonedOpenAi,
        catalogHandle,
      }),
    )
    expect(forgedProvider).toMatchObject({ code: "RALPH_CREDENTIAL_PROVIDER_UNTRUSTED" })

    const unsupportedAnthropic = await rejection(
      services.credentials.connect({
        provider: "anthropic",
        providerInfo: anthropic,
        catalogHandle,
        method: "oauth-browser",
        credentialId: "anthropic-oauth",
        label: "Unsupported Anthropic OAuth",
        nonInteractive: true,
        headless: true,
        secretSource: "not-applicable",
        allowInsecureStore: false,
      }),
    )
    expect(unsupportedAnthropic).toMatchObject({ code: "RALPH_AUTH_METHOD_UNSUPPORTED" })

    const headlessOpenAi = await rejection(
      services.credentials.connect({
        provider: "openai",
        providerInfo: openai,
        catalogHandle,
        method: "oauth-browser",
        credentialId: "openai-headless",
        label: "Headless OpenAI OAuth",
        nonInteractive: true,
        headless: true,
        secretSource: "not-applicable",
        allowInsecureStore: false,
      }),
    )
    expect(headlessOpenAi).toMatchObject({
      code: "RALPH_AUTH_BROWSER_OAUTH_UNAVAILABLE_HEADLESS",
    })
    expect(accountFlow.connectRequests).toEqual([])

    const credential = await services.credentials.connect({
      ...apiConnectRequest("openai", "boundary-key"),
      providerInfo: openai,
      catalogHandle,
    })
    const forgedSmokeHandle = await rejection(
      services.credentials.resolveForSmoke(credential.id, externalOpenAi, forgedHandle, {
        refresh: false,
      }),
    )
    expect(forgedSmokeHandle).toMatchObject({
      code: "RALPH_CREDENTIAL_CATALOG_HANDLE_UNTRUSTED",
    })
    const forgedSmokeProvider = await rejection(
      services.credentials.resolveForSmoke(credential.id, clonedOpenAi, catalogHandle, {
        refresh: false,
      }),
    )
    expect(forgedSmokeProvider).toMatchObject({ code: "RALPH_CREDENTIAL_PROVIDER_UNTRUSTED" })
    const missingStatusHandle = await rejection(
      services.credentials.status(credential, { refresh: false, provider: openai }),
    )
    expect(missingStatusHandle).toMatchObject({
      code: "RALPH_CREDENTIAL_CATALOG_HANDLE_REQUIRED",
    })
    const forgedStatusProvider = await rejection(
      services.credentials.status(credential, {
        refresh: false,
        provider: clonedOpenAi,
        catalogHandle,
      }),
    )
    expect(forgedStatusProvider).toMatchObject({ code: "RALPH_CREDENTIAL_PROVIDER_UNTRUSTED" })
    expect(
      await services.credentials.status(credential, {
        refresh: false,
        provider: openai,
        catalogHandle,
      }),
    ).toBe("connected")
    expect(counts).toEqual({ snapshotCalls: 1, providerListCalls: 0 })
  })

  test("recreates a warm manager when the trusted provider contract fingerprint changes", async () => {
    const dataRoot = await temporaryDirectory()
    const keychain = new FakeSecretStore()
    const base = await offlineCatalog().snapshot()
    const originalAnthropic = base.snapshot.providers.find(
      (provider) => provider.id === "anthropic",
    )
    const openAiDeviceCode = base.snapshot.providers
      .find((provider) => provider.id === "openai")
      ?.credentialMethods.find((method) => method.method === "device-code")
    if (!originalAnthropic || !openAiDeviceCode) {
      throw new Error("Curated manager fingerprint fixtures are incomplete")
    }
    const changed = CatalogResolutionSchema.parse({
      ...structuredClone(base),
      snapshot: {
        ...structuredClone(base.snapshot),
        contentHash: "b".repeat(64),
        id: `catalog:${"b".repeat(64)}`,
        providers: base.snapshot.providers.map((provider) =>
          provider.id === "anthropic"
            ? {
                ...structuredClone(provider),
                access: [...new Set([...provider.access, "subscription" as const])],
                credentialMethods: [
                  ...structuredClone(provider.credentialMethods),
                  structuredClone(openAiDeviceCode),
                ],
              }
            : structuredClone(provider),
        ),
      },
    })
    const counts = { snapshotCalls: 0, providerListCalls: 0 }
    const catalog: ModelCatalog = {
      snapshot: async () => {
        counts.snapshotCalls += 1
        return structuredClone(counts.snapshotCalls === 1 ? base : changed)
      },
      providers: async () => {
        counts.providerListCalls += 1
        return base.snapshot.providers
      },
      models: async () => base.snapshot.models,
      inspect: async (reference) =>
        base.snapshot.models.find(
          (model) => model.provider === reference.provider && model.id === reference.model,
        ),
    }
    const accountFlow = inertAccountFlow()
    const services = createS04Services({
      dataRoot,
      environment: {},
      catalogFactory: () => catalog,
      keychainStore: keychain,
      accountFlow,
      readSecretStdin: async () => secretInputFromValue("anthropic-first-contract"),
      now: () => NOW,
    })

    const firstHandle = await services.credentials.catalogSnapshot()
    const firstAnthropic = firstHandle.resolution.snapshot.providers.find(
      (provider) => provider.id === "anthropic",
    )
    if (!firstAnthropic) throw new Error("Missing first Anthropic contract")
    await services.credentials.connect({
      ...apiConnectRequest("anthropic", "anthropic-first"),
      providerInfo: firstAnthropic,
      catalogHandle: firstHandle,
    })

    const secondHandle = await services.credentials.catalogSnapshot()
    const secondAnthropic = secondHandle.resolution.snapshot.providers.find(
      (provider) => provider.id === "anthropic",
    )
    if (!secondAnthropic) throw new Error("Missing changed Anthropic contract")
    expect(secondAnthropic).not.toBe(firstAnthropic)
    expect(secondAnthropic.credentialMethods.map((method) => method.method)).toContain(
      "device-code",
    )
    const subscription = await services.credentials.connect({
      provider: "anthropic",
      providerInfo: secondAnthropic,
      catalogHandle: secondHandle,
      method: "device-code",
      credentialId: "anthropic-second",
      label: "Changed Anthropic contract",
      nonInteractive: false,
      headless: true,
      timeoutMs: 10_000,
      secretSource: "not-applicable",
      allowInsecureStore: false,
    })
    expect(subscription.method).toBe("device-code")
    expect(accountFlow.connectRequests).toEqual([
      { method: "device-code", headless: true, timeoutMs: 10_000 },
    ])
    expect(counts).toEqual({ snapshotCalls: 2, providerListCalls: 0 })
  })

  test("removes subscription material locally when remote revocation cannot be confirmed", async () => {
    const dataRoot = await temporaryDirectory()
    const keychain = new FakeSecretStore()
    const remoteFailureCanary = "REMOTE-REVOKE-DOWN-S04-CANARY"
    const accountFlow = inertAccountFlow()
    accountFlow.revoke = async () => {
      accountFlow.revocations += 1
      throw new Error(remoteFailureCanary)
    }
    const services = createS04Services({
      dataRoot,
      environment: {},
      catalogFactory: offlineCatalog,
      keychainStore: keychain,
      accountFlow,
      readSecretStdin: async () => secretInputFromValue("unused-api-key"),
      now: () => NOW,
    })
    const trust = await trustedProvider(services, "openai")
    const credential = await services.credentials.connect({
      provider: "openai",
      ...trust,
      method: "device-code",
      credentialId: "remote-revoke-failure",
      label: "Remote revoke failure",
      nonInteractive: true,
      headless: true,
      secretSource: "not-applicable",
      allowInsecureStore: false,
    })
    expect(await keychain.get(credential.locator)).toBeDefined()

    const failure = await services.credentials
      .revoke(credential)
      .then(() => new Error("Expected remote revocation uncertainty"))
      .catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: "RALPH_CREDENTIAL_REMOTE_REVOKE_UNCONFIRMED" })
    expect((failure as { diagnostic: { details?: unknown } }).diagnostic.details).toMatchObject({
      localRevoked: true,
      remoteRevoked: false,
    })
    expect(JSON.stringify(failure)).not.toContain(remoteFailureCanary)
    expect(accountFlow.revocations).toBe(1)
    expect(await keychain.get(credential.locator)).toBeUndefined()
    expect((await services.credentials.list()).some((ref) => ref.id === credential.id)).toBe(false)
  })

  test("runs the pinned ChatGPT device flow with structured headless instructions", async () => {
    const requests: Array<{ url: string; userAgent: string | null }> = []
    const notices: unknown[] = []
    const deviceFetch: FetchLike = async (input, init) => {
      const url = String(input)
      requests.push({ url, userAgent: new Headers(init?.headers).get("user-agent") })
      if (url.endsWith("/api/accounts/deviceauth/usercode")) {
        return new Response(
          JSON.stringify({
            device_auth_id: "device-auth-one",
            user_code: "CODE-123",
            interval: "1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.endsWith("/api/accounts/deviceauth/token")) {
        return new Response(
          JSON.stringify({
            authorization_code: "authorization-code-one",
            code_verifier: "v".repeat(43),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.endsWith("/oauth/token")) {
        return new Response(
          JSON.stringify({
            id_token: "not-a-jwt",
            access_token: "device-access-token",
            refresh_token: "device-refresh-token",
            expires_in: 3_600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      return new Response("not found", { status: 404 })
    }
    const flow = new OpenAiChatGptAccountFlow({
      fetch: deviceFetch,
      now: () => NOW,
      openBrowser: async () => {
        throw new Error("headless device flow must not open a browser")
      },
      onAuthorization: (notice) => {
        notices.push(notice)
      },
    })
    const credential = await flow.connect({
      method: "device-code",
      headless: true,
      timeoutMs: 30_000,
    })
    expect(credential).toMatchObject({
      kind: "chatgpt-subscription",
      accessToken: "device-access-token",
      refreshToken: "device-refresh-token",
      expiresAt: NOW + 3_600_000,
    })
    expect(notices).toEqual([
      {
        kind: "device",
        method: "device-code",
        url: "https://auth.openai.com/codex/device",
        instructions: "Open https://auth.openai.com/codex/device and enter code CODE-123.",
        browserOpened: false,
        userCode: "CODE-123",
      },
    ])
    expect(JSON.stringify(notices)).not.toContain("device-access-token")
    expect(requests.slice(0, 2).every((request) => request.userAgent?.startsWith("ralph/"))).toBe(
      true,
    )
    expect(requests.some((request) => request.url.endsWith("/oauth/token"))).toBe(true)
  })

  test("runs the concrete ChatGPT browser PKCE callback and persists only the extracted account metadata", async () => {
    const dataRoot = await temporaryDirectory()
    const keychain = new FakeSecretStore()
    const accountId = "account-browser-one"
    const idToken = jwt({ chatgpt_account_id: accountId })
    const accessToken = "browser-access-token-canary"
    const refreshToken = "browser-refresh-token-canary"
    const notices: unknown[] = []
    let tokenForm: URLSearchParams | undefined
    let authorize: ((notice: { url: string }) => void) | undefined
    const authorization = new Promise<{ url: string }>((resolve) => {
      authorize = resolve
    })
    const flow = new OpenAiChatGptAccountFlow({
      fetch: async (input, init) => {
        expect(String(input)).toBe("https://auth.openai.com/oauth/token")
        expect(init?.body).toBeInstanceOf(URLSearchParams)
        tokenForm = init?.body as URLSearchParams
        return new Response(
          JSON.stringify({
            id_token: idToken,
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_in: 3_600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      },
      now: () => NOW,
      openBrowser: async () => false,
      createLoopbackCallback: (options) => chatGptLoopbackCallbackFactory({ ...options, port: 0 }),
      randomBytes: deterministicOAuthRandom,
      onAuthorization: (notice) => {
        notices.push(notice)
        authorize?.(notice)
      },
    })
    const services = createS04Services({
      dataRoot,
      environment: {},
      catalogFactory: offlineCatalog,
      keychainStore: keychain,
      accountFlow: flow,
      now: () => NOW,
    })

    const connecting = services.credentials.connect(
      await trustedConnectRequest(services, {
        provider: "openai",
        method: "oauth-browser",
        credentialId: "chatgpt-browser",
        label: "ChatGPT browser",
        nonInteractive: false,
        headless: false,
        timeoutMs: 10_000,
        secretSource: "not-applicable",
        allowInsecureStore: false,
      }),
    )
    const notice = await authorization
    const authorizationUrl = new URL(notice.url)
    expect(authorizationUrl.origin).toBe("https://auth.openai.com")
    expect(authorizationUrl.pathname).toBe("/oauth/authorize")
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256")
    expect(authorizationUrl.searchParams.get("id_token_add_organizations")).toBe("true")
    expect(authorizationUrl.searchParams.get("codex_cli_simplified_flow")).toBe("true")
    expect(authorizationUrl.searchParams.get("originator")).toBe("opencode")
    expect(authorizationUrl.searchParams.has("code_verifier")).toBe(false)

    const redirectUri = authorizationUrl.searchParams.get("redirect_uri")
    const state = authorizationUrl.searchParams.get("state")
    if (!redirectUri || !state) throw new Error("Concrete authorization URL is incomplete")
    const callbackUrl = new URL(redirectUri)
    expect(callbackUrl.hostname).toBe("localhost")
    expect(callbackUrl.pathname).toBe("/auth/callback")
    callbackUrl.hostname = "127.0.0.1"
    callbackUrl.search = new URLSearchParams({ state: "wrong", code: "ignored" }).toString()
    expect((await fetch(callbackUrl)).status).toBe(400)
    callbackUrl.search = new URLSearchParams({ state, code: "browser-code" }).toString()
    expect((await fetch(callbackUrl)).status).toBe(200)

    const credential = await connecting
    expect(tokenForm?.get("grant_type")).toBe("authorization_code")
    expect(tokenForm?.get("code")).toBe("browser-code")
    expect(tokenForm?.get("redirect_uri")).toBe(redirectUri)
    const verifier = tokenForm?.get("code_verifier")
    if (!verifier) throw new Error("Concrete token exchange omitted the PKCE verifier")
    const challenge = authorizationUrl.searchParams.get("code_challenge")
    if (!challenge) throw new Error("Concrete authorization URL omitted the PKCE challenge")
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    expect(Buffer.from(digest).toString("base64url")).toBe(challenge)
    expect(credential.accountHint).toBe(accountId)

    const publicOutput = JSON.stringify({ credential, notices })
    const metadata = await readFile(services.paths.credentialMetadata, "utf8")
    const storedSecret = keychain.values.get(credential.locator) ?? ""
    for (const canary of [idToken, accessToken, refreshToken]) {
      expect(publicOutput).not.toContain(canary)
      expect(metadata).not.toContain(canary)
    }
    expect(storedSecret).toContain(accessToken)
    expect(storedSecret).toContain(refreshToken)
    expect(storedSecret).not.toContain(idToken)
    expect(storedSecret).not.toContain("idToken")
    expect(storedSecret).not.toContain("id_token")
  })

  test("fails closed when the concrete ChatGPT browser token response drifts", async () => {
    const accessToken = "drift-access-token-canary"
    const refreshToken = "drift-refresh-token-canary"
    const flow = new OpenAiChatGptAccountFlow({
      fetch: async () =>
        new Response(
          JSON.stringify({
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_in: 3_600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      now: () => NOW,
      openBrowser: async () => false,
      createLoopbackCallback: async () => ({
        redirectUri: "http://localhost:32123/auth/callback",
        wait: async () => ({ kind: "code", code: "drift-code" }),
        close: async () => undefined,
      }),
      randomBytes: deterministicOAuthRandom,
      onAuthorization: () => undefined,
    })

    const error = await flow
      .connect({ method: "oauth-browser", headless: false, timeoutMs: 10_000 })
      .then(
        () => new Error("Expected the pinned browser protocol to reject drift"),
        (cause: unknown) => cause,
      )
    expect(error).toBeInstanceOf(OpenAiDriverError)
    expect(error).toMatchObject({ kind: "protocol-drift", failClosed: true })
    expect(String(error)).not.toContain(accessToken)
    expect(String(error)).not.toContain(refreshToken)
    expect(JSON.stringify(error)).not.toContain(accessToken)
    expect(JSON.stringify(error)).not.toContain(refreshToken)
  })

  test("loads the catalog lazily and keeps two provider credentials independent", async () => {
    const dataRoot = await temporaryDirectory()
    const keychain = new FakeSecretStore()
    const canary = "sk-openai-S04-CANARY-1"
    const environmentSecret = "anthropic-S04-CANARY-2" // gitleaks:allow -- synthetic env fixture
    let catalogLoads = 0
    const services = createS04Services({
      dataRoot,
      environment: { ANTHROPIC_API_KEY: environmentSecret },
      catalogFactory: () => {
        catalogLoads += 1
        return offlineCatalog()
      },
      keychainStore: keychain,
      accountFlow: inertAccountFlow(),
      readSecretStdin: async () => secretInputFromValue(canary),
      now: () => NOW,
    })

    expect(catalogLoads).toBe(0)
    const executor = await services.credentials.connect(
      await trustedConnectRequest(services, apiConnectRequest("openai", "executor-key")),
    )
    const judge = await services.credentials.connect(
      await trustedConnectRequest(services, {
        provider: "anthropic",
        method: "environment",
        credentialId: "judge-env",
        label: "Judge environment key",
        nonInteractive: true,
        headless: true,
        environmentName: "ANTHROPIC_API_KEY",
        secretSource: "not-applicable",
        allowInsecureStore: false,
      }),
    )
    expect(catalogLoads).toBe(1)
    expect(executor).toMatchObject({
      id: "executor-key",
      provider: "openai",
      store: "os-keychain",
    })
    expect(judge).toMatchObject({
      id: "judge-env",
      provider: "anthropic",
      store: "environment",
      locator: "ANTHROPIC_API_KEY",
    })
    const executorTrust = await trustedProvider(services, "openai")
    const judgeTrust = await trustedProvider(services, "anthropic")
    expect(
      await services.credentials.status(executor, {
        refresh: false,
        provider: executorTrust.providerInfo,
        catalogHandle: executorTrust.catalogHandle,
      }),
    ).toBe("connected")
    expect(
      await services.credentials.status(judge, {
        refresh: false,
        provider: judgeTrust.providerInfo,
        catalogHandle: judgeTrust.catalogHandle,
      }),
    ).toBe("connected")

    const listed = await services.credentials.list()
    expect(listed.map((credential) => credential.id)).toEqual(["judge-env", "executor-key"])
    const metadata = await readFile(services.paths.credentialMetadata, "utf8")
    expect(metadata).not.toContain(canary)
    expect(metadata).not.toContain(environmentSecret)
    expect(JSON.stringify(listed)).not.toContain(canary)
    expect(JSON.stringify(listed)).not.toContain(environmentSecret)
    expect(keychain.values.get(executor.locator)).toBe(canary)

    await expect(
      services.credentials.connect(
        await trustedConnectRequest(services, {
          ...apiConnectRequest("openai", "unsafe-key"),
          allowInsecureStore: true,
        }),
      ),
    ).rejects.toThrow("Plaintext credential storage is intentionally unavailable")
    expect(
      (await services.credentials.list()).some((credential) => credential.id === "unsafe-key"),
    ).toBe(false)

    await services.credentials.revoke(executor)
    expect(
      await services.credentials.status(executor, {
        refresh: false,
        provider: executorTrust.providerInfo,
        catalogHandle: executorTrust.catalogHandle,
      }),
    ).toBe("revoked")
    expect(keychain.values.has(executor.locator)).toBe(false)
  })

  test("rotates ChatGPT tokens back into keychain and uses the renewed access token", async () => {
    const dataRoot = await temporaryDirectory()
    const keychain = new FakeSecretStore()
    const initial: ChatGptCredential = {
      kind: "chatgpt-subscription",
      accessToken: "chatgpt-old-access-canary",
      refreshToken: "chatgpt-old-refresh-canary",
      expiresAt: NOW + 1_000,
      accountId: "account-one",
    }
    const renewed: ChatGptCredential = {
      kind: "chatgpt-subscription",
      accessToken: "chatgpt-new-access-canary",
      refreshToken: "chatgpt-new-refresh-canary",
      expiresAt: NOW + 3_600_000,
      accountId: "account-one",
    }
    const accountFlow = new FakeAccountFlow(initial, renewed)
    let authorization = ""
    const modelFetch: FetchLike = async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? ""
      return jsonModelResponse("RALPH_SMOKE_OK")
    }
    const services = createS04Services({
      dataRoot,
      environment: {},
      catalogFactory: offlineCatalog,
      keychainStore: keychain,
      accountFlow,
      modelFetch,
      now: () => NOW,
      callId: () => "subscription-call",
    })

    const original = await services.credentials.connect(
      await trustedConnectRequest(services, {
        provider: "openai",
        method: "device-code",
        credentialId: "chatgpt-executor",
        label: "ChatGPT executor",
        nonInteractive: true,
        headless: true,
        timeoutMs: 10_000,
        secretSource: "not-applicable",
        allowInsecureStore: false,
      }),
    )
    expect(accountFlow.connectRequests).toEqual([
      { method: "device-code", headless: true, timeoutMs: 10_000 },
    ])
    const subscriptionTrust = await trustedProvider(services, "openai")
    expect(
      await services.credentials.status(original, {
        refresh: true,
        provider: subscriptionTrust.providerInfo,
        catalogHandle: subscriptionTrust.catalogHandle,
      }),
    ).toBe("connected")
    expect(accountFlow.refreshes).toBe(1)
    const current = (await services.credentials.list()).find(
      (credential) => credential.id === original.id,
    )
    expect(current?.locator).toBeDefined()
    expect(current?.locator).not.toBe(original.locator)
    expect(keychain.values.has(original.locator)).toBe(false)
    const rotated = keychain.values.get(current?.locator ?? "") ?? ""
    expect(rotated).toContain(renewed.accessToken)
    expect(rotated).toContain(renewed.refreshToken)
    expect(rotated).not.toContain(initial.accessToken)
    const metadata = await readFile(services.paths.credentialMetadata, "utf8")
    expect(metadata).not.toContain(initial.accessToken)
    expect(metadata).not.toContain(renewed.accessToken)
    expect(metadata).toContain(new Date(renewed.expiresAt).toISOString())

    const result = await services.modelSmoke.smoke(smokeRequest("chatgpt-executor", "gpt-5.4"))
    expect(result.text).toBe("RALPH_SMOKE_OK")
    expect(authorization).toBe(`Bearer ${renewed.accessToken}`)
    expect(JSON.stringify(result)).not.toContain(renewed.accessToken)
    expect(JSON.stringify(result)).not.toContain(renewed.refreshToken)
  })
})

describe("S04 concrete model smoke", () => {
  test("normalizes usage/events, redacts output before raw persistence and records catalog identity", async () => {
    const dataRoot = await temporaryDirectory()
    const keychain = new FakeSecretStore()
    const canary = "sk-S04-output-redaction-CANARY"
    let authorization = ""
    let requestBody: Record<string, unknown> = {}
    let snapshotCalls = 0
    const baseCatalog = offlineCatalog()
    const countedCatalog: ModelCatalog = {
      snapshot: async (options) => {
        snapshotCalls += 1
        return baseCatalog.snapshot(options)
      },
      providers: (options) => baseCatalog.providers(options),
      models: (query, options) => baseCatalog.models(query, options),
      inspect: (ref, options) => baseCatalog.inspect(ref, options),
    }
    const modelFetch: FetchLike = async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? ""
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonModelResponse(`RALPH_SMOKE_OK ${canary}`)
    }
    const services = createS04Services({
      dataRoot,
      environment: {},
      catalogFactory: () => countedCatalog,
      keychainStore: keychain,
      accountFlow: inertAccountFlow(),
      readSecretStdin: async () => secretInputFromValue(canary),
      modelFetch,
      now: () => NOW,
      callId: () => "api-call",
    })
    await services.credentials.connect(
      await trustedConnectRequest(services, apiConnectRequest("openai", "openai-api")),
    )
    const snapshotsBeforeSmoke = snapshotCalls
    const result = await services.modelSmoke.smoke({
      ...smokeRequest("openai-api"),
      variant: "high",
      refreshCatalog: true,
    })

    expect(authorization).toBe(`Bearer ${canary}`)
    expect(snapshotCalls - snapshotsBeforeSmoke).toBe(1)
    expect(requestBody).toMatchObject({ reasoning: { effort: "high" }, store: false })
    expect(requestBody).not.toHaveProperty("tools")
    expect(result.effectiveParameters).toEqual({ reasoning_effort: "high" })
    expect(result.text).toBe("RALPH_SMOKE_OK [REDACTED]")
    expect(result.finishReason).toBe("stop")
    expect(result.usage).toEqual(
      TokenUsageSchema.parse({
        input: 10,
        output: 2,
        reasoning: 2,
        total: 14,
        source: "reported",
        semantics: "final",
        providerRawRef: result.rawRef,
      }),
    )
    expect(result.catalogSnapshotId).toMatch(/^catalog:[a-f0-9]{64}$/)
    expect(result.catalogOrigin).toBe("source")
    expect(result.events?.map((event) => ProviderEventSchema.parse(event).type)).toContain(
      "model.call.finished",
    )
    const finish = result.events?.find((event) => event.type === "model.call.finished")
    expect(finish?.payload).toMatchObject({
      rawRef: result.rawRef,
      catalogSnapshotId: result.catalogSnapshotId,
      catalogOrigin: "source",
    })

    const raw = await readFile(rawSmokePath(services.paths.rawSmoke, result.rawRef ?? ""), "utf8")
    expect(raw).not.toContain(canary)
    expect(raw).toContain(result.catalogSnapshotId)
    expect(raw).toContain('"origin": "source"')
    expect(raw).toContain('"reasoning_effort": "high"')
    expect(result.rawRef).not.toContain(canary)
    expect(JSON.stringify(result)).not.toContain(canary)
    const metadata = await readFile(services.paths.credentialMetadata, "utf8")
    expect(metadata).not.toContain(canary)
  })

  test("reports unavailable rather than an empty derived usage when provider omits counters", async () => {
    const dataRoot = await temporaryDirectory()
    const services = createS04Services({
      dataRoot,
      environment: {},
      catalogFactory: offlineCatalog,
      keychainStore: new FakeSecretStore(),
      accountFlow: inertAccountFlow(),
      readSecretStdin: async () => secretInputFromValue("sk-no-usage-canary"),
      modelFetch: async () => jsonModelResponse("RALPH_SMOKE_OK", false),
      now: () => NOW,
      callId: () => "no-usage-call",
    })
    await services.credentials.connect(
      await trustedConnectRequest(services, apiConnectRequest("openai", "no-usage-api")),
    )
    const result = await services.modelSmoke.smoke(smokeRequest("no-usage-api"))
    expect(result.usage).toMatchObject({ source: "unavailable", semantics: "final" })
    expect(
      result.events?.find((event) => event.type === "model.usage.updated")?.payload,
    ).toMatchObject({
      usage: { source: "unavailable" },
    })
  })

  test("publishes provider usage deltas without relabeling their aggregate as another delta", async () => {
    const dataRoot = await temporaryDirectory()
    const services = createS04Services({
      dataRoot,
      environment: {},
      catalogFactory: offlineCatalog,
      keychainStore: new FakeSecretStore(),
      accountFlow: inertAccountFlow(),
      readSecretStdin: async () => secretInputFromValue("sk-usage-delta-canary"),
      modelFetch: async () =>
        sseModelResponse([
          {
            type: "response.usage.delta",
            sequence_number: 0,
            usage: { input_tokens: 2, output_tokens: 1 },
          },
          {
            type: "response.usage.delta",
            sequence_number: 1,
            usage: { output_tokens: 2 },
          },
          { type: "response.completed", sequence_number: 2, response: {} },
        ]),
      now: () => NOW,
      callId: () => "usage-delta-call",
    })
    await services.credentials.connect(
      await trustedConnectRequest(services, apiConnectRequest("openai", "usage-delta-api")),
    )

    const result = await services.modelSmoke.smoke(smokeRequest("usage-delta-api"))
    const updates = result.events?.filter((event) => event.type === "model.usage.updated") ?? []
    const deltas = updates.filter((event) => event.payload.usage.semantics === "delta")
    expect(deltas.map((event) => event.payload.usage)).toEqual([
      expect.objectContaining({ input: 2, output: 1, total: 3, semantics: "delta" }),
      expect.objectContaining({ output: 2, total: 2, semantics: "delta" }),
    ])
    expect(updates.at(-1)?.payload.usage).toMatchObject({
      input: 2,
      output: 3,
      total: 5,
      semantics: "final",
    })
    expect(result.usage).toMatchObject({ input: 2, output: 3, total: 5, semantics: "final" })
  })

  test("rejects unknown and conflicting parameters before any provider request", async () => {
    const dataRoot = await temporaryDirectory()
    let providerCalls = 0
    const services = createS04Services({
      dataRoot,
      environment: {},
      catalogFactory: offlineCatalog,
      keychainStore: new FakeSecretStore(),
      accountFlow: inertAccountFlow(),
      readSecretStdin: async () => secretInputFromValue("sk-parameter-validation-canary"),
      modelFetch: async () => {
        providerCalls += 1
        return jsonModelResponse("unexpected")
      },
      now: () => NOW,
      callId: () => "invalid-parameter-call",
    })
    await services.credentials.connect(
      await trustedConnectRequest(services, apiConnectRequest("openai", "parameter-api")),
    )

    await expect(
      services.modelSmoke.smoke({
        ...smokeRequest("parameter-api", "gpt-5.4"),
        parameters: { temperature: 0 },
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_MODEL_PARAMETER_UNKNOWN" })
    await expect(
      services.modelSmoke.smoke({
        ...smokeRequest("parameter-api", "gpt-5.4"),
        variant: "high",
        parameters: { reasoning_effort: "low" },
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_MODEL_PARAMETER_CONFLICT" })
    expect(providerCalls).toBe(0)
  })

  test("persists a redacted raw rate-limit failure and fails closed for catalog-only providers", async () => {
    const dataRoot = await temporaryDirectory()
    const canary = "sk-rate-limit-S04-CANARY"
    const services = createS04Services({
      dataRoot,
      environment: {},
      catalogFactory: offlineCatalog,
      keychainStore: new FakeSecretStore(),
      accountFlow: inertAccountFlow(),
      readSecretStdin: async () => secretInputFromValue(canary),
      modelFetch: async () =>
        new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "2" },
        }),
      now: () => NOW,
      callId: () => "rate-limit-call",
    })
    await services.credentials.connect(
      await trustedConnectRequest(services, apiConnectRequest("openai", "rate-api")),
    )

    let failure: unknown
    try {
      await services.modelSmoke.smoke(smokeRequest("rate-api"))
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(ModelSmokeFailure)
    expect(failure).toMatchObject({ kind: "rate-limit", retryAfterMs: 2_000 })
    const rawRef = (failure as ModelSmokeFailure).rawRef
    if (!rawRef) throw new Error("Expected a persisted raw reference for the provider failure")
    expect((failure as ModelSmokeFailure).diagnostic.details).toMatchObject({
      kind: "rate-limit",
      rawRef,
      retryAfterMs: 2_000,
      events: expect.arrayContaining([
        expect.objectContaining({
          type: "model.provider.error",
          synthesized: false,
          payload: expect.objectContaining({ kind: "rate-limit", rawRef }),
        }),
        expect.objectContaining({
          type: "model.call.finished",
          payload: expect.objectContaining({ finishReason: "error", rawRef }),
        }),
      ]),
    })
    const raw = await readFile(rawSmokePath(services.paths.rawSmoke, rawRef), "utf8")
    expect(raw).toContain('"kind": "rate-limit"')
    expect(raw).not.toContain(canary)
    expect(JSON.stringify(failure)).not.toContain(canary)

    await expect(
      services.modelSmoke.smoke({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        credentialId: "rate-api",
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
        prompt: "read only",
        tools: [],
        readOnly: true,
        refreshCatalog: false,
        telemetry: {
          persist_raw_output: true,
          event_retention: null,
          redact: true,
        },
        diagnosticScope: process.cwd(),
      }),
    ).rejects.toThrow("catalog-only")
  })

  test("marks a locally synthesized provider failure event as synthesized", async () => {
    const dataRoot = await temporaryDirectory()
    const services = createS04Services({
      dataRoot,
      environment: {},
      catalogFactory: offlineCatalog,
      keychainStore: new FakeSecretStore(),
      accountFlow: inertAccountFlow(),
      readSecretStdin: async () => secretInputFromValue("sk-transport-failure-canary"),
      modelFetch: async () => {
        throw new TypeError("simulated disconnected transport")
      },
      now: () => NOW,
      callId: () => "transport-failure-call",
    })
    await services.credentials.connect(
      await trustedConnectRequest(services, apiConnectRequest("openai", "transport-api")),
    )

    const failure = await services.modelSmoke
      .smoke(smokeRequest("transport-api"))
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ModelSmokeFailure)
    const events = (failure as ModelSmokeFailure).events
    expect(events.find((event) => event.type === "model.provider.error")).toMatchObject({
      synthesized: true,
      payload: { kind: "transport" },
    })
    expect(events.at(-1)).toMatchObject({
      type: "model.call.finished",
      synthesized: true,
      payload: { finishReason: "error" },
    })
  })

  test("refuses raw persistence through a linked directory", async () => {
    const dataRoot = await temporaryDirectory()
    const services = createS04Services({
      dataRoot,
      environment: {},
      catalogFactory: offlineCatalog,
      keychainStore: new FakeSecretStore(),
      accountFlow: inertAccountFlow(),
      readSecretStdin: async () => secretInputFromValue("sk-linked-path-canary"),
      modelFetch: async () => jsonModelResponse("RALPH_SMOKE_OK"),
      now: () => NOW,
      callId: () => "linked-path-call",
    })
    await services.credentials.connect(
      await trustedConnectRequest(services, apiConnectRequest("openai", "linked-api")),
    )
    const outside = join(dataRoot, "outside-raw-target")
    await mkdir(outside, { recursive: true })
    await mkdir(dirname(services.paths.rawSmoke), { recursive: true })
    await symlink(
      outside,
      services.paths.rawSmoke,
      process.platform === "win32" ? "junction" : "dir",
    )

    await expect(services.modelSmoke.smoke(smokeRequest("linked-api"))).rejects.toThrow(
      "symbolic link or junction",
    )
  })
})

describe("S04 minimal profile form", () => {
  test("uses the shared field metadata, confirms and returns a schema-valid profile", async () => {
    const metadata = roleProfileFormMetadata("executor-main")
    const answers: Readonly<Record<string, string>> = {
      scope: "workspace",
      role: "executor",
      backend: "embedded",
      provider: "openai",
      model: "gpt-5.4-mini",
      parameters: "{}",
      requireTools: "yes",
      requireStructuredOutput: "no",
    }
    const seen: TerminalProfilePrompt[] = []
    const form = createTerminalProfileForm({
      isTty: () => true,
      prompt: async (prompt) => {
        seen.push(prompt)
        return prompt.kind === "confirm" ? "yes" : (answers[prompt.field.id] ?? "")
      },
    })
    const response = await form({
      profileId: "executor-main",
      suggested: {
        parameters: {},
        requirements: {
          input: [],
          tools: false,
          tool_streaming: false,
          reasoning: false,
          structured_output: false,
          usage: [],
          access: [],
        },
        fallback_profiles: [],
        fallback_on: [],
        limits: {},
      },
      metadata,
    })
    expect(response).toMatchObject({
      scope: "workspace",
      profile: {
        role: "executor",
        backend: "embedded",
        provider: "openai",
        model: "gpt-5.4-mini",
        requirements: { tools: true, structured_output: false },
      },
    })
    expect(
      seen.filter((prompt) => prompt.kind === "field").map((prompt) => prompt.field.id),
    ).toEqual(ROLE_PROFILE_FORM_METADATA.map((field) => field.id))
    expect(seen.every((prompt) => prompt.kind === "confirm" || !prompt.field.secret)).toBe(true)
    expect(JSON.stringify(response)).not.toMatch(/api[_-]?key|access[_-]?token|refresh[_-]?token/i)
  })

  test("cancels without producing config and does not prompt outside a TTY", async () => {
    const request = {
      profileId: "judge-main",
      suggested: {},
      metadata: roleProfileFormMetadata("judge-main"),
    }
    const cancelled = createTerminalProfileForm({
      isTty: () => true,
      prompt: async () => "cancel",
    })
    expect(await cancelled(request)).toBeUndefined()

    let prompted = false
    const headless = createTerminalProfileForm({
      isTty: () => false,
      prompt: async () => {
        prompted = true
        return "should-not-be-used"
      },
    })
    expect(await headless(request)).toBeUndefined()
    expect(prompted).toBe(false)
  })
})
