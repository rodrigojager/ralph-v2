import type {
  LoopbackCallbackFactory,
  LoopbackCallbackResult,
  OAuthFetch,
  OAuthRandomBytes,
} from "@ralph-next/credentials"

export type ScriptedOAuthStep =
  | {
      kind: "response"
      status?: number
      json?: unknown
      body?: BodyInit | null
      headers?: Readonly<Record<string, string>>
    }
  | { kind: "error"; error: Error | string }
  | { kind: "freeze" }

export type ScriptedOAuthRequest = {
  url: string
  init: RequestInit | undefined
}

type FrozenOAuthRequest = {
  active: boolean
  resolve(response: Response): void
  reject(error: unknown): void
  cleanup(): void
}

function abortError(): DOMException {
  return new DOMException("aborted", "AbortError")
}

function responseFromStep(step: Extract<ScriptedOAuthStep, { kind: "response" }>): Response {
  if (step.json !== undefined && step.body !== undefined) {
    throw new Error("Scripted OAuth response cannot define both json and body")
  }
  const body = step.json === undefined ? (step.body ?? null) : JSON.stringify(step.json)
  return new Response(body, {
    status: step.status ?? 200,
    headers: {
      ...(step.json === undefined ? {} : { "content-type": "application/json" }),
      ...(step.headers ?? {}),
    },
  })
}

/** Queue-backed OAuth transport including malformed, failure and frozen requests. */
export class ScriptedOAuthFetch {
  readonly requests: ScriptedOAuthRequest[] = []
  readonly #queue: ScriptedOAuthStep[]
  readonly #frozen: FrozenOAuthRequest[] = []

  constructor(steps: readonly ScriptedOAuthStep[]) {
    this.#queue = [...steps]
  }

  readonly fetch: OAuthFetch = async (input, init) => {
    this.requests.push({ url: String(input), init })
    const step = this.#queue.shift()
    if (!step) throw new Error("Scripted OAuth response queue exhausted")
    if (step.kind === "error") {
      throw typeof step.error === "string" ? new Error(step.error) : step.error
    }
    if (step.kind === "response") return responseFromStep(step)
    if (init?.signal?.aborted) throw abortError()
    return new Promise<Response>((resolve, reject) => {
      const onAbort = (): void => {
        frozen.active = false
        reject(abortError())
      }
      const frozen: FrozenOAuthRequest = {
        active: true,
        resolve: (response) => {
          if (!frozen.active) return
          frozen.active = false
          init?.signal?.removeEventListener("abort", onAbort)
          resolve(response)
        },
        reject: (error) => {
          if (!frozen.active) return
          frozen.active = false
          init?.signal?.removeEventListener("abort", onAbort)
          reject(error)
        },
        cleanup: () => init?.signal?.removeEventListener("abort", onAbort),
      }
      this.#frozen.push(frozen)
      init?.signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  releaseNextFrozen(step: Extract<ScriptedOAuthStep, { kind: "response" }>): void {
    const frozen = this.#frozen.find((candidate) => candidate.active)
    if (!frozen) throw new Error("No frozen OAuth request is waiting")
    frozen.resolve(responseFromStep(step))
  }

  rejectNextFrozen(error: Error | string): void {
    const frozen = this.#frozen.find((candidate) => candidate.active)
    if (!frozen) throw new Error("No frozen OAuth request is waiting")
    frozen.reject(typeof error === "string" ? new Error(error) : error)
  }

  pendingFrozen(): number {
    return this.#frozen.filter((candidate) => candidate.active).length
  }

  remaining(): number {
    return this.#queue.length
  }

  close(): void {
    for (const frozen of this.#frozen) {
      frozen.cleanup()
      if (frozen.active) frozen.reject(new Error("Scripted OAuth transport closed"))
    }
  }
}

export function oauthJsonStep(json: unknown, status = 200): ScriptedOAuthStep {
  return { kind: "response", status, json }
}

export function oauthMalformedStep(body = "{not-json", status = 200): ScriptedOAuthStep {
  return {
    kind: "response",
    status,
    body,
    headers: { "content-type": "application/json" },
  }
}

export function oauthFreezeStep(): ScriptedOAuthStep {
  return { kind: "freeze" }
}

/** Stable PKCE/state entropy without sharing mutable module-level state between tests. */
export function deterministicOAuthRandom(seed = 37): OAuthRandomBytes {
  if (!Number.isSafeInteger(seed)) throw new Error("OAuth random seed must be a safe integer")
  let invocation = 0
  return (size) => {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("OAuth random size is invalid")
    invocation += 1
    return Uint8Array.from({ length: size }, (_, index) => (index + invocation * seed) % 256)
  }
}

export type ScriptedLoopbackStep = LoopbackCallbackResult | { kind: "freeze" }

/** Headless browser callback fake; no socket or browser is opened. */
export class ScriptedLoopbackOAuth {
  readonly requests: Array<{
    host: "127.0.0.1"
    port: number
    path: string
    expectedState: string
  }> = []
  closed = 0
  readonly #queue: ScriptedLoopbackStep[]

  constructor(steps: readonly ScriptedLoopbackStep[]) {
    this.#queue = [...steps]
  }

  readonly factory: LoopbackCallbackFactory = async (options) => {
    this.requests.push(options)
    const step = this.#queue.shift()
    if (!step) throw new Error("Scripted loopback callback queue exhausted")
    let closed = false
    return {
      redirectUri: `http://127.0.0.1:${options.port || 32123}${options.path}`,
      wait: async (signal) => {
        if (step.kind !== "freeze") return step
        if (signal.aborted) throw abortError()
        return new Promise<LoopbackCallbackResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(abortError()), { once: true })
        })
      },
      close: async () => {
        if (closed) return
        closed = true
        this.closed += 1
      },
    }
  }

  remaining(): number {
    return this.#queue.length
  }
}
