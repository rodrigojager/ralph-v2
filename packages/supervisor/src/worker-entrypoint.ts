import { createHash } from "node:crypto"
import { readFileSync, realpathSync, type Stats, statSync } from "node:fs"
import { isAbsolute, relative, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import { WORKER_OPERATION_SCHEMA_VERSION } from "./worker-operations"
import { WORKER_PROTOCOL_VERSION, type WorkerRole, WorkerRoleSchema } from "./worker-protocol"
import {
  createWorkerRoleOperationRegistry,
  type RalphWorkerRoleAdapter,
} from "./worker-role-runtime"
import { runWorkerRuntime } from "./worker-runtime"

export const RALPH_WORKER_ROLE_ENV = "RALPH_WORKER_ROLE"
export const RALPH_WORKER_ADAPTER_MODULE_ENV = "RALPH_WORKER_ADAPTER_MODULE"
export const RALPH_WORKER_ADAPTER_HASH_ENV = "RALPH_WORKER_ADAPTER_HASH"
export const RALPH_WORKER_ADAPTER_KIND_ENV = "RALPH_WORKER_ADAPTER_KIND"

export type RalphWorkerAdapterFactoryContext = {
  readonly role: WorkerRole
  readonly protocolVersion: typeof WORKER_PROTOCOL_VERSION
  readonly operationSchemaVersion: typeof WORKER_OPERATION_SCHEMA_VERSION
}

export type RalphWorkerAdapterModule = {
  createRalphWorkerRoleAdapter(
    context: RalphWorkerAdapterFactoryContext,
  ): RalphWorkerRoleAdapter | Promise<RalphWorkerRoleAdapter>
}

export type BuiltinWorkerAdapterFactory = RalphWorkerAdapterModule["createRalphWorkerRoleAdapter"]

export type WorkerEntrypointOptions = {
  readonly role: WorkerRole
  readonly adapter: RalphWorkerRoleAdapter
  readonly maximumMessageBytes?: number
  readonly onProtocolError?: (error: unknown) => void
}

function comparablePath(path: string): string {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

export function workerAdapterModuleContentHash(adapterModule: string): string {
  if (!isAbsolute(adapterModule)) {
    throw new Error("Worker adapter module must be an absolute file path")
  }
  const canonicalModule = realpathSync.native(adapterModule)
  const before = statSync(canonicalModule)
  if (!before.isFile()) {
    throw new Error(`Worker adapter module is not a regular file: ${adapterModule}`)
  }
  const bytes = readFileSync(canonicalModule)
  const after = statSync(canonicalModule)
  const canonicalAfter = realpathSync.native(canonicalModule)
  if (
    !sameFileSnapshot(before, after) ||
    comparablePath(canonicalAfter) !== comparablePath(canonicalModule)
  ) {
    throw new Error(`Worker adapter module changed while it was hashed: ${adapterModule}`)
  }
  return createHash("sha256").update(bytes).digest("hex")
}

export function workerEntrypointEnvironment(input: {
  readonly role: WorkerRole
  readonly adapterModule: string
  readonly adapterHash: string
  readonly base?: Readonly<Record<string, string>>
}): Record<string, string> {
  const role = WorkerRoleSchema.parse(input.role)
  const adapterModule = input.adapterModule.trim()
  if (!adapterModule || adapterModule.length > 32_768) {
    throw new Error("Worker adapter module must be a non-empty bounded specifier")
  }
  if (!isAbsolute(adapterModule)) {
    throw new Error("Worker adapter module must be an absolute file path")
  }
  const adapterHash = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(input.adapterHash)
  return {
    ...input.base,
    [RALPH_WORKER_ROLE_ENV]: role,
    [RALPH_WORKER_ADAPTER_MODULE_ENV]: adapterModule,
    [RALPH_WORKER_ADAPTER_HASH_ENV]: adapterHash,
  }
}

function moduleSpecifier(value: string): string {
  if (!isAbsolute(value)) throw new Error("Worker adapter module must be an absolute file path")
  return pathToFileURL(value).href
}

function assertAdapterMatchesRole(
  adapter: RalphWorkerRoleAdapter,
  expectedRole: WorkerRole,
): RalphWorkerRoleAdapter {
  if (!adapter || typeof adapter !== "object" || adapter.role !== expectedRole) {
    throw new Error(`Worker adapter does not implement the requested role ${expectedRole}`)
  }
  switch (adapter.role) {
    case "executor-model":
      if (typeof adapter.execute !== "function") {
        throw new Error("Executor model worker adapter must implement execute")
      }
      return adapter
    case "judge":
      if (typeof adapter.evaluate !== "function") {
        throw new Error("Judge worker adapter must implement evaluate")
      }
      return adapter
    case "tool-gate":
      if (typeof adapter.executeTool !== "function" && typeof adapter.executeGate !== "function") {
        throw new Error("Tool/gate worker adapter must implement executeTool or executeGate")
      }
      return adapter
    case "child-run":
      if (typeof adapter.executeChild !== "function") {
        throw new Error("Child run worker adapter must implement executeChild")
      }
      return adapter
    case "git-integration":
      if (typeof adapter.integrate !== "function") {
        throw new Error("Git integration worker adapter must implement integrate")
      }
      return adapter
  }
}

/** Runs a role-specific worker with no persistence or transition dependency. */
export async function runWorkerEntrypoint(options: WorkerEntrypointOptions): Promise<void> {
  const role = WorkerRoleSchema.parse(options.role)
  const adapter = assertAdapterMatchesRole(options.adapter, role)
  await runWorkerRuntime({
    operations: createWorkerRoleOperationRegistry(adapter),
    expectedRole: role,
    ...(options.maximumMessageBytes === undefined
      ? {}
      : { maximumMessageBytes: options.maximumMessageBytes }),
    ...(options.onProtocolError ? { onProtocolError: options.onProtocolError } : {}),
  })
}

async function loadRoleAdapter(
  role: WorkerRole,
  adapterModule: string,
  expectedHash: string,
  workspaceRoot: string,
): Promise<RalphWorkerRoleAdapter> {
  const canonicalModule = realpathSync.native(adapterModule)
  const canonicalWorkspace = realpathSync.native(workspaceRoot)
  const relativeToWorkspace = relative(canonicalWorkspace, canonicalModule)
  if (
    relativeToWorkspace === "" ||
    (!isAbsolute(relativeToWorkspace) &&
      relativeToWorkspace !== ".." &&
      !relativeToWorkspace.startsWith(`..${sep}`))
  ) {
    throw new Error(
      "Worker adapter modules inside the mutable target workspace require S09 sandbox/bundling",
    )
  }
  const actualHash = workerAdapterModuleContentHash(canonicalModule)
  if (actualHash !== expectedHash) {
    throw new Error(`Worker adapter module hash mismatch for role ${role}`)
  }
  const imported: unknown = await import(moduleSpecifier(canonicalModule))
  if (workerAdapterModuleContentHash(canonicalModule) !== expectedHash) {
    throw new Error(`Worker adapter module changed while it was imported for role ${role}`)
  }
  if (
    !imported ||
    typeof imported !== "object" ||
    !("createRalphWorkerRoleAdapter" in imported) ||
    typeof imported.createRalphWorkerRoleAdapter !== "function"
  ) {
    throw new Error(
      `Worker adapter module must export createRalphWorkerRoleAdapter for role ${role}`,
    )
  }
  const factory =
    imported.createRalphWorkerRoleAdapter as RalphWorkerAdapterModule["createRalphWorkerRoleAdapter"]
  const adapter = await factory({
    role,
    protocolVersion: WORKER_PROTOCOL_VERSION,
    operationSchemaVersion: WORKER_OPERATION_SCHEMA_VERSION,
  })
  return assertAdapterMatchesRole(adapter, role)
}

/**
 * Loads the command-selected adapter module and starts the private IPC runtime.
 * The module path and role are supervisor-owned environment values; neither is
 * accepted from a model payload or from the worker operation itself.
 */
export async function runWorkerEntrypointFromEnvironment(
  options: { readonly builtinFactory?: BuiltinWorkerAdapterFactory } = {},
): Promise<void> {
  if (process.env.RALPH_WORKER !== "1" || !process.connected) {
    throw new Error("Ralph worker entrypoint requires a supervisor-owned IPC channel")
  }
  const role = WorkerRoleSchema.parse(process.env[RALPH_WORKER_ROLE_ENV])
  const adapterKind = process.env[RALPH_WORKER_ADAPTER_KIND_ENV]?.trim() || "module"
  if (adapterKind === "builtin") {
    if (!options.builtinFactory) {
      throw new Error(`No built-in worker adapter factory is composed for role ${role}`)
    }
    const factory = options.builtinFactory
    await runWorkerRuntime({
      expectedRole: role,
      async loadOperations() {
        const adapter = assertAdapterMatchesRole(
          await factory({
            role,
            protocolVersion: WORKER_PROTOCOL_VERSION,
            operationSchemaVersion: WORKER_OPERATION_SCHEMA_VERSION,
          }),
          role,
        )
        return createWorkerRoleOperationRegistry(adapter)
      },
    })
    return
  }
  if (adapterKind !== "module") {
    throw new Error(`Unknown worker adapter kind for role ${role}: ${adapterKind}`)
  }
  const adapterModule = process.env[RALPH_WORKER_ADAPTER_MODULE_ENV]?.trim()
  if (!adapterModule || adapterModule.length > 32_768) {
    throw new Error(`Missing ${RALPH_WORKER_ADAPTER_MODULE_ENV} for role ${role}`)
  }
  const adapterHash = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(process.env[RALPH_WORKER_ADAPTER_HASH_ENV])

  await runWorkerRuntime({
    expectedRole: role,
    async loadOperations(identity) {
      const adapter = await loadRoleAdapter(
        role,
        adapterModule,
        adapterHash,
        identity.workspaceRoot,
      )
      return createWorkerRoleOperationRegistry(adapter)
    },
  })
}
