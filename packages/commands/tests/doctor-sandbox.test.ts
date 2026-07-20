import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EXIT_CODES, RalphError, type SandboxCapability } from "../../domain/src/index"
import type {
  SandboxCapabilityCommandService,
  SandboxCapabilityDiscoveryRequest,
} from "../src/handlers"
import { executeCli } from "../src/index"

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ralph-doctor-sandbox-"))
  temporaryRoots.push(root)
  return root
}

class FixtureSandboxCapabilities implements SandboxCapabilityCommandService {
  readonly requests: SandboxCapabilityDiscoveryRequest[] = []

  constructor(readonly capability: SandboxCapability) {}

  async discover(request: SandboxCapabilityDiscoveryRequest): Promise<SandboxCapability> {
    this.requests.push(request)
    return this.capability
  }
}

type DoctorCheck = {
  id: string
  status: "passed" | "warning" | "failed" | "skipped"
  required: boolean
  message: string
  hint?: string
  details?: Record<string, unknown>
}

function context(root: string, sandboxCapabilities: SandboxCapabilityCommandService) {
  return {
    version: "0.1.0-test",
    cwd: root,
    environment: { RALPH_CONFIG_HOME: join(root, "global-config") },
    sandboxCapabilities,
  }
}

function sandboxCheck(result: Awaited<ReturnType<typeof executeCli>>): DoctorCheck {
  const data = result.execution.result.data as { checks: DoctorCheck[] }
  const check = data.checks.find((candidate) => candidate.id === "sandbox.capability")
  if (!check) throw new Error("sandbox.capability doctor check is missing")
  return check
}

async function writeSandboxConfig(root: string, body: readonly string[]): Promise<void> {
  const configHome = join(root, "global-config")
  await mkdir(configHome, { recursive: true })
  await writeFile(join(configHome, "config.yaml"), ["schema_version: 1", ...body, ""].join("\n"))
}

const PROCESS_CAPABILITY: SandboxCapability = {
  schemaVersion: 1,
  backend: "process",
  available: true,
  filesystemIsolation: "policy",
  networkIsolation: "none",
  processIsolation: "supervised",
  supportsNetworkAllowlist: false,
  reason:
    "Local process backend relies on Ralph policy and supervision; it is not a container boundary",
}

describe("doctor sandbox capability", () => {
  test("does not probe an unconfigured backend when sandbox is disabled", async () => {
    const root = await temporaryRoot()
    const service = new FixtureSandboxCapabilities(PROCESS_CAPABILITY)

    const result = await executeCli(
      ["doctor", "--non-interactive", "--format", "json"],
      context(root, service),
    )
    const check = sandboxCheck(result)

    expect(result.exitCode).toBe(0)
    expect(service.requests).toEqual([])
    expect(check).toMatchObject({
      status: "skipped",
      required: false,
      details: { enabled: false, configuredProvider: "process" },
    })
    expect(check.message).toContain("was not probed")
  })

  test("reports local process containment honestly without claiming a container boundary", async () => {
    const root = await temporaryRoot()
    await writeSandboxConfig(root, ["sandbox:", "  enabled: true", "  provider: process"])
    const service = new FixtureSandboxCapabilities(PROCESS_CAPABILITY)

    const result = await executeCli(
      ["doctor", "--non-interactive", "--format", "json"],
      context(root, service),
    )
    const check = sandboxCheck(result)
    const diagnostic = result.execution.result.diagnostics.find(
      (candidate) => candidate.code === "RALPH_DOCTOR_SANDBOX_CAPABILITY",
    )

    expect(result.exitCode).toBe(0)
    expect(service.requests.map(({ backend }) => backend)).toEqual(["process"])
    expect(check).toMatchObject({
      status: "warning",
      required: true,
      details: {
        enabled: true,
        configuredProvider: "process",
        capability: PROCESS_CAPABILITY,
      },
    })
    expect(check.message).toContain("not a complete container boundary")
    expect(diagnostic?.details).toEqual(check.details)
  })

  test("fails when configured isolation requirements exceed the selected capability", async () => {
    const root = await temporaryRoot()
    await writeSandboxConfig(root, [
      "sandbox:",
      "  enabled: true",
      "  provider: process",
      "  require_container_isolation: true",
    ])
    const service = new FixtureSandboxCapabilities(PROCESS_CAPABILITY)

    const result = await executeCli(
      ["doctor", "--non-interactive", "--format", "json"],
      context(root, service),
    )
    const check = sandboxCheck(result)

    expect(result.exitCode).toBe(1)
    expect(check).toMatchObject({
      status: "failed",
      required: true,
      details: {
        configuredProvider: "process",
        capabilityProblem: { code: "RALPH_SANDBOX_ISOLATION_INSUFFICIENT" },
      },
    })
    expect(check.message).toContain("requires a container filesystem boundary")
  })

  test("preserves command cancellation instead of diagnosing the backend as unavailable", async () => {
    const root = await temporaryRoot()
    await writeSandboxConfig(root, ["sandbox:", "  enabled: true", "  provider: process"])
    const service: SandboxCapabilityCommandService = {
      discover: () =>
        Promise.reject(
          new RalphError(
            "RALPH_SANDBOX_CAPABILITY_DISCOVERY_CANCELLED",
            "process capability discovery was cancelled",
            { exitCode: EXIT_CODES.interrupted },
          ),
        ),
    }

    const result = await executeCli(
      ["doctor", "--non-interactive", "--format", "json"],
      context(root, service),
    )

    expect(result.exitCode).toBe(8)
    expect(result.execution.result).toMatchObject({
      ok: false,
      command: "error",
      diagnostics: [{ code: "RALPH_SANDBOX_CAPABILITY_DISCOVERY_CANCELLED" }],
    })
  })

  test("fails when the explicitly configured container backend is unavailable", async () => {
    const root = await temporaryRoot()
    await writeSandboxConfig(root, [
      "sandbox:",
      "  enabled: true",
      "  provider: docker",
      "  image: example.invalid/ralph-fixture:latest",
    ])
    const dockerUnavailable: SandboxCapability = {
      schemaVersion: 1,
      backend: "docker",
      available: false,
      filesystemIsolation: "container",
      networkIsolation: "container",
      processIsolation: "container",
      supportsNetworkAllowlist: false,
      reason: "Docker fixture service is unavailable",
    }
    const service = new FixtureSandboxCapabilities(dockerUnavailable)

    const result = await executeCli(
      ["doctor", "--non-interactive", "--format", "json"],
      context(root, service),
    )
    const check = sandboxCheck(result)

    expect(result.exitCode).toBe(1)
    expect(result.execution.result.ok).toBe(false)
    expect(service.requests.map(({ backend }) => backend)).toEqual(["docker"])
    expect(check).toMatchObject({
      status: "failed",
      required: true,
      details: {
        enabled: true,
        configuredProvider: "docker",
        capability: dockerUnavailable,
      },
    })
    expect(check.message).toContain("Docker fixture service is unavailable")
  })
})
