import { describe, expect, test } from "bun:test"
import type { SecretProcessRequest, SecretProcessResult, SecretProcessRunner } from "../src/index"
import { OsKeychainSecretStore, REDACTED_SECRET } from "../src/index"

const success = (stdout = ""): SecretProcessResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
  timedOut: false,
})

class RecordingRunner implements SecretProcessRunner {
  readonly requests: SecretProcessRequest[] = []
  readonly #responses: SecretProcessResult[]

  constructor(...responses: SecretProcessResult[]) {
    this.#responses = [...responses]
  }

  async run(request: SecretProcessRequest): Promise<SecretProcessResult> {
    this.requests.push(request)
    const response = this.#responses.shift()
    if (!response) throw new Error("No fake process response configured")
    return response
  }
}

describe("OS keychain adapter", () => {
  test("passes a Windows secret through stdin and redacts process failures", async () => {
    const secret = "windows-keychain-canary-1234"
    const runner = new RecordingRunner(success("ok"), success())
    const store = new OsKeychainSecretStore({ platform: "win32", runner })

    await store.put("credential-1", secret)

    expect(runner.requests).toHaveLength(2)
    const put = runner.requests[1]
    if (!put) throw new Error("Expected a Windows keychain put request")
    expect(put.args.join(" ")).not.toContain(secret)
    expect(put.stdin).toContain(secret)
    expect(put.executable).toBe("powershell.exe")
    expect(put.args).toContain("-EncodedCommand")

    const failing = new RecordingRunner(success("ok"), {
      exitCode: 1,
      stdout: secret,
      stderr: `native tool echoed ${secret}`,
      timedOut: false,
    })
    const failingStore = new OsKeychainSecretStore({ platform: "win32", runner: failing })
    const error = await failingStore.put("credential-2", secret).then(
      () => new Error("Expected keychain failure"),
      (cause: unknown) => cause as Error,
    )
    expect(error.message).not.toContain(secret)
    expect(error.message).toContain(REDACTED_SECRET)
  })

  test("round-trips macOS secrets as base64 without putting them in argv", async () => {
    const secret = "macos-keychain-canary-5678" // gitleaks:allow -- synthetic redaction fixture
    const encoded = Buffer.from(secret, "utf8").toString("base64")
    const runner = new RecordingRunner(success(), success(), success(), success(`${encoded}\n`))
    const store = new OsKeychainSecretStore({ platform: "darwin", runner })

    await store.put("credential-1", secret)
    const put = runner.requests[1]
    if (!put) throw new Error("Expected a macOS keychain put request")
    expect(put.args.join(" ")).not.toContain(secret)
    expect(put.stdin).not.toContain(secret)
    expect(put.stdin).toContain(encoded)
    expect(await store.get("credential-1")).toBe(secret)
  })

  test("passes Linux secrets only through stdin", async () => {
    const secret = "linux-keychain-canary-9012"
    const runner = new RecordingRunner(success(), success(), success(), success(`${secret}\n`))
    const store = new OsKeychainSecretStore({ platform: "linux", runner })

    await store.put("credential-1", secret)
    const put = runner.requests[1]
    if (!put) throw new Error("Expected a Linux keychain put request")
    expect(put.executable).toBe("secret-tool")
    expect(put.args.join(" ")).not.toContain(secret)
    expect(put.stdin).toBe(secret)
    expect(await store.get("credential-1")).toBe(secret)
  })

  test("fails closed on unsupported platforms without starting a process", async () => {
    const runner = new RecordingRunner()
    const store = new OsKeychainSecretStore({ platform: "aix", runner })

    expect(await store.probe()).toEqual({
      kind: "os-keychain",
      available: false,
      backend: "unsupported:aix",
      detail: "OS credential store is unsupported on aix",
    })
    await expect(store.put("credential-1", "unsupported-canary")).rejects.toThrow("unsupported")
    expect(runner.requests).toHaveLength(0)
  })
})
