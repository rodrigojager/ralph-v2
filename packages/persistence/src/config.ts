import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import {
  cloneDefaultConfig,
  completeRoleProfileConfigLayer,
  composeRoleProfileConfigLayer,
  DEFAULT_CONFIG,
  type EffectiveConfig,
  type EffectiveValue,
  EXIT_CODES,
  GlobalConfigLayerSchema,
  ProfileIdSchema,
  type RalphConfig,
  type RalphConfigLayer,
  RalphConfigLayerSchema,
  RalphConfigSchema,
  RalphError,
  type RoleProfileConfig,
  type RoleProfileConfigLayer,
  RoleProfileConfigLayerSchema,
  RoleProfileConfigSchema,
  roleProfileLayerPathSemantics,
} from "@ralph/domain"
import { LineCounter, parseDocument, stringify } from "yaml"
import type { ZodIssue } from "zod"
import { writeFileAtomic } from "./atomic"
import { workspaceLayout } from "./paths"

type ConfigLayer = Record<string, unknown>
type ConfigLocation = { line: number; column: number }
type ConfigDocument = {
  value: ConfigLayer
  locate: (path: readonly PropertyKey[]) => ConfigLocation | undefined
}

type LoadEffectiveConfigOptions = {
  workspaceConfig?: string
  environment?: Record<string, string | undefined>
  cli?: {
    mode?: string
    ui?: string
    lang?: string
  }
}

function isObject(value: unknown): value is ConfigLayer {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

async function configPathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw new RalphError(
      "RALPH_CONFIG_INSPECTION_FAILED",
      `Could not inspect configuration: ${path}`,
      {
        exitCode: EXIT_CODES.invalidUsage,
        file: path,
        cause: error,
      },
    )
  }
}

type HeldConfigLock = {
  readonly path: string
  readonly token: string
  readonly handle: Awaited<ReturnType<typeof open>>
  readonly device: number
  readonly inode: number
}

async function acquireConfigLock(target: string): Promise<HeldConfigLock> {
  const directory = dirname(target)
  await mkdir(directory, { recursive: true })
  const path = join(directory, `.${basename(target)}.ralph-config.lock`)
  const token = randomUUID()
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, "wx+", 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    throw new RalphError(
      "RALPH_CONFIG_LOCK_HELD",
      "Another process owns the configuration mutation lock",
      {
        exitCode: EXIT_CODES.conflict,
        file: path,
        hint: "Wait for the writer to finish. A lock left by a crashed process must be inspected and removed explicitly; age alone never proves it stale.",
      },
    )
  }
  try {
    const document = `${JSON.stringify({
      schemaVersion: 1,
      token,
      pid: process.pid,
      target: resolve(target),
      acquiredAt: new Date().toISOString(),
    })}\n`
    await handle.writeFile(document)
    await handle.sync()
    const identity = await handle.stat()
    return { path, token, handle, device: identity.dev, inode: identity.ino }
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(path).catch(() => undefined)
    throw error
  }
}

async function releaseConfigLock(lock: HeldConfigLock): Promise<void> {
  const opened = await lock.handle.stat()
  if (opened.dev !== lock.device || opened.ino !== lock.inode) {
    await lock.handle.close().catch(() => undefined)
    throw new RalphError(
      "RALPH_CONFIG_LOCK_IDENTITY_LOST",
      "Configuration lock handle identity changed before release",
      { exitCode: EXIT_CODES.conflict, file: lock.path },
    )
  }
  await lock.handle.close()
  const pathIdentity = await lstat(lock.path).catch((error: unknown) => {
    throw new RalphError(
      "RALPH_CONFIG_LOCK_IDENTITY_LOST",
      "Configuration lock disappeared before release",
      { exitCode: EXIT_CODES.conflict, file: lock.path, cause: error },
    )
  })
  if (
    !pathIdentity.isFile() ||
    pathIdentity.isSymbolicLink() ||
    pathIdentity.size > 4_096 ||
    pathIdentity.dev !== lock.device ||
    pathIdentity.ino !== lock.inode
  ) {
    throw new RalphError(
      "RALPH_CONFIG_LOCK_IDENTITY_LOST",
      "Configuration lock path was replaced before release",
      { exitCode: EXIT_CODES.conflict, file: lock.path },
    )
  }
  const verificationHandle = await open(lock.path, "r")
  let lockDocument: string
  try {
    const verificationIdentity = await verificationHandle.stat()
    if (
      verificationIdentity.dev !== lock.device ||
      verificationIdentity.ino !== lock.inode ||
      verificationIdentity.size > 4_096
    ) {
      throw new RalphError(
        "RALPH_CONFIG_LOCK_IDENTITY_LOST",
        "Configuration lock changed while ownership was verified",
        { exitCode: EXIT_CODES.conflict, file: lock.path },
      )
    }
    const bytes = Buffer.alloc(verificationIdentity.size)
    const read = await verificationHandle.read(bytes, 0, bytes.byteLength, 0)
    if (read.bytesRead !== bytes.byteLength) {
      throw new RalphError(
        "RALPH_CONFIG_LOCK_IDENTITY_LOST",
        "Configuration lock could not be read completely during release",
        { exitCode: EXIT_CODES.conflict, file: lock.path },
      )
    }
    lockDocument = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } finally {
    await verificationHandle.close()
  }
  let observedToken: unknown
  try {
    observedToken = (JSON.parse(lockDocument) as { token?: unknown }).token
  } catch {
    observedToken = undefined
  }
  if (observedToken !== lock.token) {
    throw new RalphError(
      "RALPH_CONFIG_LOCK_OWNERSHIP_LOST",
      "Configuration lock ownership changed before release",
      { exitCode: EXIT_CODES.conflict, file: lock.path },
    )
  }
  const confirmedIdentity = await lstat(lock.path)
  if (
    !confirmedIdentity.isFile() ||
    confirmedIdentity.isSymbolicLink() ||
    confirmedIdentity.dev !== lock.device ||
    confirmedIdentity.ino !== lock.inode
  ) {
    throw new RalphError(
      "RALPH_CONFIG_LOCK_IDENTITY_LOST",
      "Configuration lock was replaced before compare-and-delete release",
      { exitCode: EXIT_CODES.conflict, file: lock.path },
    )
  }
  await unlink(lock.path)
}

function configLockOrderKey(path: string): string {
  const absolute = resolve(path)
  return process.platform === "win32" ? absolute.toLocaleLowerCase("en-US") : absolute
}

async function withConfigLocks<T>(
  targets: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const orderedTargets = [
    ...new Map(
      targets.map((target) => [configLockOrderKey(target), resolve(target)] as const),
    ).entries(),
  ]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, target]) => target)
  const locks: HeldConfigLock[] = []
  let outcome:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown }
  try {
    for (const target of orderedTargets) locks.push(await acquireConfigLock(target))
    outcome = { ok: true, value: await operation() }
  } catch (error) {
    outcome = { ok: false, error }
  }

  const releaseErrors: unknown[] = []
  for (const lock of [...locks].reverse()) {
    try {
      await releaseConfigLock(lock)
    } catch (error) {
      releaseErrors.push(error)
    }
  }
  if (!outcome.ok) {
    if (releaseErrors.length > 0) {
      throw new AggregateError(
        [outcome.error, ...releaseErrors],
        "Configuration operation and lock release both failed",
      )
    }
    throw outcome.error
  }
  if (releaseErrors.length > 0) {
    throw new AggregateError(releaseErrors, "One or more configuration locks could not be released")
  }
  return outcome.value
}

async function withConfigLock<T>(target: string, operation: () => Promise<T>): Promise<T> {
  return withConfigLocks([target], operation)
}

const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"])

function assertSafeConfigKeys(
  value: ConfigLayer,
  file: string,
  locate: ConfigDocument["locate"],
  prefix: readonly PropertyKey[] = [],
): void {
  for (const [key, item] of Object.entries(value)) {
    const segments = [...prefix, key]
    const path = segments.join(".")
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      const location = locate(segments)
      throw new RalphError("RALPH_CONFIG_KEY_FORBIDDEN", `Forbidden configuration key: ${path}`, {
        exitCode: EXIT_CODES.invalidUsage,
        file,
        ...(location ? location : {}),
        details: { path },
      })
    }
    if (isObject(item)) assertSafeConfigKeys(item, file, locate, segments)
  }
}

type SourceProjectionOptions = {
  /** Empty merge objects are no-ops; only effective empty values receive provenance. */
  readonly recordEmptyObject?: (path: string) => boolean
  /** Preserve a source already selected by a higher configuration layer. */
  readonly onlyMissing?: boolean
  /** An empty object produced by tombstones inherits the strongest child provenance. */
  readonly preferDescendantSourceForEmpty?: boolean
}

const CONFIG_SOURCE_PRECEDENCE: Readonly<Record<EffectiveValue["source"], number>> = {
  builtin: 0,
  global: 1,
  workspace: 2,
  env: 3,
  profile: 4,
  prd: 5,
  task: 6,
  cli: 7,
}

function strongestDescendantSource(
  output: Readonly<Record<string, EffectiveValue>>,
  path: string,
): EffectiveValue | undefined {
  let selected: EffectiveValue | undefined
  for (const [candidatePath, candidate] of Object.entries(output)) {
    if (!candidatePath.startsWith(`${path}.`)) continue
    if (
      !selected ||
      CONFIG_SOURCE_PRECEDENCE[candidate.source] > CONFIG_SOURCE_PRECEDENCE[selected.source]
    ) {
      selected = candidate
    }
  }
  return selected
}

function setSources(
  value: unknown,
  source: EffectiveValue["source"],
  sourceRef: string,
  output: Record<string, EffectiveValue>,
  prefix = "",
  options: SourceProjectionOptions = {},
): void {
  if (isObject(value)) {
    const entries = Object.entries(value)
    if (entries.length === 0 && prefix && options.recordEmptyObject?.(prefix)) {
      if (options.onlyMissing && Object.hasOwn(output, prefix)) return
      const descendant = options.preferDescendantSourceForEmpty
        ? strongestDescendantSource(output, prefix)
        : undefined
      output[prefix] = descendant
        ? {
            value: {},
            source: descendant.source,
            ...(descendant.sourceRef ? { sourceRef: descendant.sourceRef } : {}),
          }
        : { value: {}, source, sourceRef }
      return
    }
    for (const [key, item] of entries) {
      const path = prefix ? `${prefix}.${key}` : key
      setSources(item, source, sourceRef, output, path, options)
    }
    return
  }
  if (prefix && (!options.onlyMissing || !Object.hasOwn(output, prefix))) {
    output[prefix] = { value, source, sourceRef }
  }
}

function mergeLayer(target: ConfigLayer, layer: ConfigLayer, prefix: readonly string[] = []): void {
  for (const [key, value] of Object.entries(layer)) {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      throw new Error(`Unsafe configuration key reached merge boundary: ${key}`)
    }
    const existing = Object.hasOwn(target, key) ? target[key] : undefined
    if (prefix.length === 1 && prefix[0] === "profiles" && isObject(value)) {
      target[key] = composeRoleProfileConfigLayer(isObject(existing) ? existing : {}, value)
    } else if (isObject(value) && isObject(existing)) {
      mergeLayer(existing, value, [...prefix, key])
    } else target[key] = structuredClone(value)
  }
}

function deleteSourcePath(output: Record<string, EffectiveValue>, path: string): void {
  for (const key of Object.keys(output)) {
    if (key === path || key.startsWith(`${path}.`)) delete output[key]
  }
}

function deleteExactSourcePath(output: Record<string, EffectiveValue>, path: string): void {
  delete output[path]
}

function prepareRoleProfileSourceMerge(
  target: ConfigLayer,
  layer: ConfigLayer,
  output: Record<string, EffectiveValue>,
  absolutePrefix: readonly string[],
  relativePrefix: readonly string[] = [],
): void {
  for (const [key, value] of Object.entries(layer)) {
    const relativePath = [...relativePrefix, key]
    const absolutePath = [...absolutePrefix, key]
    const serializedPath = absolutePath.join(".")
    const semantics = roleProfileLayerPathSemantics(relativePath)
    if ((value === null && semantics === "tombstone") || semantics === "replace") {
      deleteSourcePath(output, serializedPath)
      continue
    }
    const existing = Object.hasOwn(target, key) ? target[key] : undefined
    if (isObject(value) && isObject(existing)) {
      if (Object.keys(value).length > 0) deleteExactSourcePath(output, serializedPath)
      prepareRoleProfileSourceMerge(existing, value, output, absolutePath, relativePath)
    } else {
      deleteSourcePath(output, serializedPath)
    }
  }
}

function prepareSourceMerge(
  target: ConfigLayer,
  layer: ConfigLayer,
  output: Record<string, EffectiveValue>,
  prefix: readonly string[] = [],
): void {
  for (const [key, value] of Object.entries(layer)) {
    const path = [...prefix, key]
    const existing = Object.hasOwn(target, key) ? target[key] : undefined
    if (prefix.length === 1 && prefix[0] === "profiles" && isObject(value)) {
      prepareRoleProfileSourceMerge(isObject(existing) ? existing : {}, value, output, path)
    } else if (isObject(value) && isObject(existing)) {
      if (Object.keys(value).length > 0) deleteExactSourcePath(output, path.join("."))
      prepareSourceMerge(existing, value, output, path)
    } else {
      deleteSourcePath(output, path.join("."))
    }
  }
}

function mergeLayerWithSources(
  target: ConfigLayer,
  layer: ConfigLayer,
  source: EffectiveValue["source"],
  sourceRef: string,
  output: Record<string, EffectiveValue>,
): void {
  prepareSourceMerge(target, layer, output)
  mergeLayer(target, layer)
  setSources(layer, source, sourceRef, output, "", {
    recordEmptyObject: () => true,
  })
}

function pruneIneffectiveEmptyObjectSources(
  config: ConfigLayer,
  output: Record<string, EffectiveValue>,
): void {
  for (const [path, projected] of Object.entries(output)) {
    if (!isObject(projected.value) || Object.keys(projected.value).length > 0) continue
    const effective = configValueAtPath(config, path.split("."))
    if (!isObject(effective) || Object.keys(effective).length > 0) delete output[path]
  }
}

const LEGACY_WATCHDOG_ALIASES = {
  lease_timeout: "heartbeat_grace",
  probe_attempts: "confirmations",
  hard_attempt_timeout: "hard_timeout",
} as const

type LegacyWatchdogKey = keyof typeof LEGACY_WATCHDOG_ALIASES
type CanonicalWatchdogKey = (typeof LEGACY_WATCHDOG_ALIASES)[LegacyWatchdogKey]

/**
 * Keeps schema v1 workspaces readable after the watchdog gained explicit
 * multi-signal terminology. The strict domain schema only sees canonical
 * fields; aliases are accepted solely at this input boundary.
 */
function normalizeLegacyWatchdogLayer(document: ConfigDocument, path: string): ConfigLayer {
  const layer = structuredClone(document.value)
  const watchdog = layer.watchdog
  if (!isObject(watchdog)) return layer

  for (const [legacyKey, canonicalKey] of Object.entries(LEGACY_WATCHDOG_ALIASES) as Array<
    [LegacyWatchdogKey, CanonicalWatchdogKey]
  >) {
    if (!Object.hasOwn(watchdog, legacyKey)) continue
    if (Object.hasOwn(watchdog, canonicalKey)) {
      const location = document.locate(["watchdog", legacyKey])
      throw new RalphError(
        "RALPH_CONFIG_WATCHDOG_ALIAS_CONFLICT",
        `Watchdog configuration cannot declare both ${legacyKey} and ${canonicalKey}`,
        {
          exitCode: EXIT_CODES.invalidUsage,
          file: path,
          ...(location ? location : {}),
          details: {
            legacyPath: `watchdog.${legacyKey}`,
            canonicalPath: `watchdog.${canonicalKey}`,
          },
        },
      )
    }
    watchdog[canonicalKey] = watchdog[legacyKey]
    delete watchdog[legacyKey]
  }
  return layer
}

function locateNormalizedConfigPath(
  document: ConfigDocument,
  path: readonly PropertyKey[],
): ConfigLocation | undefined {
  const direct = document.locate(path)
  if (direct || path[0] !== "watchdog" || typeof path[1] !== "string") return direct

  const canonicalKey = path[1]
  const legacyEntry = Object.entries(LEGACY_WATCHDOG_ALIASES).find(
    ([, canonical]) => canonical === canonicalKey,
  )
  if (!legacyEntry) return undefined
  return document.locate(["watchdog", legacyEntry[0], ...path.slice(2)])
}

export function globalConfigPath(
  environment: Record<string, string | undefined> = process.env,
): string {
  if (environment.RALPH_CONFIG_HOME) {
    return join(resolve(environment.RALPH_CONFIG_HOME), "config.yaml")
  }
  if (process.platform === "win32" && environment.APPDATA) {
    return join(environment.APPDATA, "ralph", "config.yaml")
  }
  const base = environment.XDG_CONFIG_HOME
    ? resolve(environment.XDG_CONFIG_HOME)
    : join(homedir(), ".config")
  return join(base, "ralph", "config.yaml")
}

async function readConfigDocument(path: string): Promise<ConfigDocument> {
  let text: string
  try {
    text = await Bun.file(path).text()
  } catch (error) {
    throw new RalphError("RALPH_CONFIG_READ_FAILED", `Could not read configuration: ${path}`, {
      exitCode: EXIT_CODES.invalidUsage,
      file: path,
      cause: error,
    })
  }

  const lineCounter = new LineCounter()
  const document = parseDocument(text, {
    lineCounter,
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  })
  if (document.errors.length > 0) {
    const first = document.errors[0]
    const location = first?.linePos?.[0]
    throw new RalphError("RALPH_CONFIG_YAML_INVALID", first?.message ?? "Invalid YAML", {
      exitCode: EXIT_CODES.invalidUsage,
      file: path,
      ...(location?.line ? { line: location.line } : {}),
      ...(location?.col ? { column: location.col } : {}),
    })
  }
  let value: unknown
  try {
    value = document.toJS({ maxAliasCount: 50 })
  } catch (error) {
    throw new RalphError(
      "RALPH_CONFIG_YAML_ALIAS_LIMIT",
      "Configuration YAML exceeds the bounded alias expansion limit",
      {
        exitCode: EXIT_CODES.invalidUsage,
        file: path,
        cause: error,
      },
    )
  }
  if (!isObject(value)) {
    throw new RalphError("RALPH_CONFIG_ROOT_INVALID", "Configuration root must be a mapping", {
      exitCode: EXIT_CODES.invalidUsage,
      file: path,
    })
  }
  const locate = (segments: readonly PropertyKey[]): ConfigLocation | undefined => {
    const yamlPath = segments.filter(
      (segment): segment is string | number =>
        typeof segment === "string" || typeof segment === "number",
    )
    const node = document.getIn(yamlPath, true) as { range?: readonly number[] } | undefined
    const offset = node?.range?.[0]
    if (offset === undefined) return undefined
    const location = lineCounter.linePos(offset)
    return { line: location.line, column: location.col }
  }
  assertSafeConfigKeys(value, path, locate)
  return { value, locate }
}

export async function readConfigLayer(path: string): Promise<ConfigLayer> {
  return (await readConfigDocument(path)).value
}

function issuePath(issue: ZodIssue): PropertyKey[] {
  if (issue.code === "unrecognized_keys" && issue.keys.length > 0) {
    return [...issue.path, issue.keys[0] as string]
  }
  return issue.path
}

function validateLayer(
  document: ConfigDocument,
  path: string,
  options: { requireSchemaVersion: boolean },
): ConfigLayer {
  const layer = normalizeLegacyWatchdogLayer(document, path)
  const schema = options.requireSchemaVersion ? RalphConfigLayerSchema : GlobalConfigLayerSchema
  const parsed = schema.safeParse(layer)
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0]
    const firstLocation = firstIssue
      ? locateNormalizedConfigPath(document, issuePath(firstIssue))
      : undefined
    throw new RalphError("RALPH_CONFIG_SCHEMA_INVALID", "Configuration layer is invalid", {
      exitCode: EXIT_CODES.invalidUsage,
      file: path,
      ...(firstLocation ? firstLocation : {}),
      details: {
        issues: parsed.error.issues.map((issue) => ({
          path: issuePath(issue).join("."),
          message: issue.message,
        })),
      },
    })
  }
  const validated = parsed.data as ConfigLayer
  assertProfilesContainNoSecretMaterial(validated)
  return validated
}

export async function readWorkspaceConfig(path: string): Promise<RalphConfigLayer> {
  const document = await readConfigDocument(path)
  return validateLayer(document, path, { requireSchemaVersion: true }) as RalphConfigLayer
}

export async function writeDefaultConfig(path: string): Promise<void> {
  const yaml = stringify({ schema_version: 1 }, { indent: 2, lineWidth: 100 })
  await writeFileAtomic(path, yaml, { overwrite: false, mode: 0o600 })
}

export async function loadEffectiveConfig(
  options: LoadEffectiveConfigOptions = {},
): Promise<EffectiveConfig> {
  const environment = options.environment ?? process.env
  const config = cloneDefaultConfig() as unknown as ConfigLayer
  const values: Record<string, EffectiveValue> = {}
  setSources(config, "builtin", "ralph-v2 defaults", values, "", {
    recordEmptyObject: () => true,
  })

  const globalPath = globalConfigPath(environment)
  if (await configPathExists(globalPath)) {
    const globalLayer = validateLayer(await readConfigDocument(globalPath), globalPath, {
      requireSchemaVersion: false,
    })
    mergeLayerWithSources(config, globalLayer, "global", globalPath, values)
  }

  if (options.workspaceConfig && (await configPathExists(options.workspaceConfig))) {
    const workspaceLayer = await readWorkspaceConfig(options.workspaceConfig)
    mergeLayerWithSources(config, workspaceLayer, "workspace", options.workspaceConfig, values)
  }

  const envLayer: ConfigLayer = { defaults: {} }
  const envDefaults = envLayer.defaults as ConfigLayer
  if (environment.RALPH_MODE) envDefaults.mode = environment.RALPH_MODE
  if (environment.RALPH_UI) envDefaults.ui = environment.RALPH_UI
  if (environment.RALPH_LANG) envDefaults.lang = environment.RALPH_LANG
  if (Object.keys(envDefaults).length > 0) {
    mergeLayerWithSources(config, envLayer, "env", "environment", values)
  }

  const cliLayer: ConfigLayer = { defaults: {} }
  const cliDefaults = cliLayer.defaults as ConfigLayer
  if (options.cli?.mode) cliDefaults.mode = options.cli.mode
  if (options.cli?.ui) cliDefaults.ui = options.cli.ui
  if (options.cli?.lang) cliDefaults.lang = options.cli.lang
  if (Object.keys(cliDefaults).length > 0) {
    mergeLayerWithSources(config, cliLayer, "cli", "command line", values)
  }

  const parsed = RalphConfigSchema.safeParse(config)
  if (!parsed.success) {
    throw new RalphError(
      "RALPH_EFFECTIVE_CONFIG_INVALID",
      "The merged effective configuration is invalid",
      {
        exitCode: EXIT_CODES.invalidUsage,
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
          globalConfig: globalPath,
          workspaceConfig: options.workspaceConfig,
        },
      },
    )
  }

  // Zod supplies defaults inside profiles only after all raw layers have been
  // merged. Backfill only paths that no explicit layer sourced, including
  // effective empty objects. Descendant tombstones win for objects emptied by
  // an explicit clear, so an empty value is never mislabeled as builtin.
  pruneIneffectiveEmptyObjectSources(parsed.data as unknown as ConfigLayer, values)
  setSources(parsed.data, "builtin", "ralph-v2 defaults", values, "", {
    recordEmptyObject: () => true,
    onlyMissing: true,
    preferDescendantSourceForEmpty: true,
  })

  return { config: parsed.data, values }
}

/**
 * Composes already captured, schema-valid layers without touching the
 * filesystem. Commands that later commit with layer hashes can therefore build
 * their candidate from the exact bytes those hashes represent.
 */
export function composeEffectiveConfigLayers(input: {
  readonly global?: RalphConfigLayer
  readonly workspace?: RalphConfigLayer
}): RalphConfig {
  const config = cloneDefaultConfig() as unknown as ConfigLayer
  if (input.global) {
    const global = input.global as unknown as ConfigLayer
    assertProfilesContainNoSecretMaterial(global)
    mergeLayer(config, global)
  }
  if (input.workspace) {
    const workspace = input.workspace as unknown as ConfigLayer
    assertProfilesContainNoSecretMaterial(workspace)
    mergeLayer(config, workspace)
  }
  return RalphConfigSchema.parse(config)
}

export function effectiveValue(config: EffectiveConfig, path: string): EffectiveValue | undefined {
  return config.values[path]
}

export function configDirectory(path: string): string {
  return dirname(path)
}

export type ProfileConfigMutation = {
  path: string
  profileId: string
  previous?: RoleProfileConfigLayer
  profile: RoleProfileConfig
  created: boolean
  defaultSelection?: {
    role: "executor" | "judge"
    previous?: string
    profileId: string
  }
}

export type SettingsConfigScope = "workspace" | "global"

/**
 * The generic settings editor deliberately cannot mutate profiles or extension
 * payloads. Profiles have their own typed command and credentials remain
 * references outside this boundary.
 */
export type SettingsConfigPatch = Omit<
  RalphConfigLayer,
  "schema_version" | "profiles" | "extensions"
>

export type SettingsConfigLeafChange = {
  path: string
  previous: unknown
  value: unknown
}

export type SettingsConfigMutation = {
  scope: SettingsConfigScope
  path: string
  created: boolean
  changes: readonly SettingsConfigLeafChange[]
}

export type WriteSettingsConfigInput =
  | {
      scope: "workspace"
      workspaceRoot: string
      patch: SettingsConfigPatch
    }
  | {
      scope: "global"
      environment?: Record<string, string | undefined>
      /** Active workspace context used to validate the effective overlay. */
      workspaceRoot?: string
      patch: SettingsConfigPatch
    }

function assertDefaultProfileRole(
  config: RalphConfig,
  role: "executor" | "judge",
  profileId: string,
  path: string,
): void {
  const profile = config.profiles[profileId]
  if (
    role === "executor" &&
    profileId === DEFAULT_CONFIG.defaults.executor_profile &&
    profile === undefined
  ) {
    // The provider-neutral builtin points at an intentionally unmaterialized
    // bootstrap profile until the owner configures an executor route.
    return
  }
  if (profile?.role === role) return
  throw new RalphError(
    "RALPH_PROFILE_DEFAULT_ROLE_CHANGE_BLOCKED",
    `Profile ${profileId} is the active ${role} default and cannot resolve as ${profile?.role ?? "missing"}`,
    {
      exitCode: EXIT_CODES.invalidUsage,
      file: path,
      hint: `Select another ${role} profile with profiles configure --set-default before changing this profile's role, or use a new profile ID.`,
      details: {
        role,
        profileId,
        resolvedRole: profile?.role ?? null,
      },
    },
  )
}

function assertProfileDefaultCompatibility(
  config: RalphConfig,
  profileId: string,
  path: string,
): void {
  if (config.defaults.executor_profile === profileId) {
    assertDefaultProfileRole(config, "executor", profileId, path)
  }
  if (config.defaults.judge_profile === profileId) {
    assertDefaultProfileRole(config, "judge", profileId, path)
  }
}

const SettingsConfigPatchSchema = RalphConfigLayerSchema.omit({
  schema_version: true,
  profiles: true,
  extensions: true,
}).strict()

function configValueAtPath(value: ConfigLayer, path: readonly string[]): unknown {
  let current: unknown = value
  for (const segment of path) {
    if (!isObject(current) || !Object.hasOwn(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

function settingsPatchLeaves(
  value: ConfigLayer,
  prefix: readonly string[] = [],
): Array<{ path: readonly string[]; value: unknown }> {
  const output: Array<{ path: readonly string[]; value: unknown }> = []
  for (const [key, item] of Object.entries(value)) {
    const path = [...prefix, key]
    if (isObject(item) && Object.keys(item).length > 0) {
      output.push(...settingsPatchLeaves(item, path))
    } else {
      output.push({ path, value: structuredClone(item) })
    }
  }
  return output
}

/**
 * Atomically updates only schema-known, non-profile defaults. The caller picks
 * a semantic scope; it cannot inject an output path. Workspace writes always
 * target `<resolved root>/.ralph/config.yaml`, while global writes always use
 * the platform config resolver.
 */
export async function writeSettingsConfig(
  input: WriteSettingsConfigInput,
): Promise<SettingsConfigMutation> {
  const patchRecord = input.patch as ConfigLayer
  assertSafeConfigKeys(patchRecord, "settings draft", () => undefined)
  const parsedPatch = SettingsConfigPatchSchema.safeParse(patchRecord)
  if (!parsedPatch.success) {
    throw new RalphError(
      "RALPH_SETTINGS_CONFIG_PATCH_INVALID",
      "The settings draft is not a valid non-secret configuration patch",
      {
        exitCode: EXIT_CODES.invalidUsage,
        details: {
          issues: parsedPatch.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      },
    )
  }

  const target =
    input.scope === "workspace"
      ? workspaceLayout(resolve(input.workspaceRoot)).config
      : globalConfigPath(input.environment)
  return withConfigLock(target, async () => {
    const exists = await configPathExists(target)
    const current = exists
      ? validateLayer(await readConfigDocument(target), target, {
          requireSchemaVersion: input.scope === "workspace",
        })
      : { schema_version: 1 }
    const next = structuredClone(current)
    next.schema_version ??= 1
    mergeLayer(next, parsedPatch.data as ConfigLayer)

    const layerSchema =
      input.scope === "workspace" ? RalphConfigLayerSchema : GlobalConfigLayerSchema
    const validated = layerSchema.safeParse(next)
    if (!validated.success) {
      throw new RalphError(
        "RALPH_SETTINGS_CONFIG_LAYER_INVALID",
        "The configuration layer would be invalid after applying the settings draft",
        {
          exitCode: EXIT_CODES.invalidUsage,
          file: target,
          details: {
            issues: validated.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
        },
      )
    }
    const effective = await assertEffectiveCandidate(
      input.scope,
      validated.data as ConfigLayer,
      input,
    )
    const scopeEffective =
      input.scope === "workspace" || !input.workspaceRoot
        ? effective
        : await assertEffectiveCandidate("global", validated.data as ConfigLayer, {
            ...(input.environment ? { environment: input.environment } : {}),
          })
    const defaultsPatch = parsedPatch.data.defaults
    if (defaultsPatch?.executor_profile !== undefined) {
      assertDefaultProfileRole(scopeEffective, "executor", defaultsPatch.executor_profile, target)
      if (
        scopeEffective !== effective &&
        effective.defaults.executor_profile === defaultsPatch.executor_profile
      ) {
        assertDefaultProfileRole(effective, "executor", defaultsPatch.executor_profile, target)
      }
    }
    if (defaultsPatch?.judge_profile !== undefined && defaultsPatch.judge_profile !== null) {
      assertDefaultProfileRole(scopeEffective, "judge", defaultsPatch.judge_profile, target)
      if (
        scopeEffective !== effective &&
        effective.defaults.judge_profile === defaultsPatch.judge_profile
      ) {
        assertDefaultProfileRole(effective, "judge", defaultsPatch.judge_profile, target)
      }
    }

    const changes = settingsPatchLeaves(parsedPatch.data as ConfigLayer).map((leaf) => ({
      path: leaf.path.join("."),
      previous: structuredClone(configValueAtPath(current, leaf.path)),
      value: structuredClone(leaf.value),
    }))
    await writeFileAtomic(target, stringify(validated.data, { indent: 2, lineWidth: 100 }), {
      overwrite: exists,
      mode: 0o600,
    })
    return {
      scope: input.scope,
      path: target,
      created: !exists,
      changes,
    }
  })
}

/**
 * Atomically writes one non-secret role profile layer and, when requested, its
 * matching default pointer in the same locked write. The complete effective
 * profile is supplied independently and must exactly match composition of the
 * partial layer under the locked target/peer snapshots. Credential material
 * cannot cross this boundary because config accepts only reference IDs.
 */
export async function writeRoleProfileConfig(
  path: string,
  profileId: string,
  profile: RoleProfileConfig,
  options: {
    workspace: boolean
    /** Exact partial target layer. Omit only for the legacy complete replacement contract. */
    profileLayer?: RoleProfileConfigLayer
    /** Updates the matching defaults.*_profile pointer in the same lock/write. */
    setDefault?: boolean
    /** Active workspace root to overlay when mutating the global profile set. */
    workspaceRoot?: string
    environment?: Record<string, string | undefined>
    /** Target snapshot observed before the command composed a complete profile. */
    expectedTargetSha256?: string | null
    /** Other config layer read to compose/validate this complete profile. */
    peerConfigSnapshot?: {
      readonly path: string
      readonly expectedSha256: string | null
    }
    /** Runs under the same target lock against the latest effective candidate. */
    validateEffective: (config: RalphConfig) => void | Promise<void>
  },
): Promise<ProfileConfigMutation> {
  const parsedId = ProfileIdSchema.safeParse(profileId)
  const parsedProfile = RoleProfileConfigSchema.safeParse(profile)
  const parsedProfileLayer = RoleProfileConfigLayerSchema.safeParse(
    options.profileLayer ??
      (parsedProfile.success ? completeRoleProfileConfigLayer(parsedProfile.data) : {}),
  )
  if (!parsedId.success || !parsedProfile.success || !parsedProfileLayer.success) {
    throw new RalphError("RALPH_PROFILE_CONFIG_INVALID", "Role profile configuration is invalid", {
      exitCode: EXIT_CODES.invalidUsage,
      file: path,
      details: {
        issues: [
          ...(!parsedId.success
            ? parsedId.error.issues.map((issue) => ({ path: "id", message: issue.message }))
            : []),
          ...(!parsedProfile.success
            ? parsedProfile.error.issues.map((issue) => ({
                path: ["profiles", profileId, ...issue.path].join("."),
                message: issue.message,
              }))
            : []),
          ...(!parsedProfileLayer.success
            ? parsedProfileLayer.error.issues.map((issue) => ({
                path: ["profiles", profileId, ...issue.path].join("."),
                message: issue.message,
              }))
            : []),
        ],
      },
    })
  }
  // Apply the same fail-closed secret policy used by config transfer to both
  // representations. Checking only the layer would leave the legacy complete
  // profile contract as a bypass; checking only the complete profile would
  // miss a tombstoned/replaced raw value before composition.
  assertNoSecretMaterial(parsedProfileLayer.data)
  assertNoSecretMaterial(parsedProfile.data)

  const peerPath =
    options.peerConfigSnapshot &&
    configLockOrderKey(options.peerConfigSnapshot.path) !== configLockOrderKey(path)
      ? options.peerConfigSnapshot.path
      : undefined
  return withConfigLocks(peerPath ? [path, peerPath] : [path], async () => {
    const baseline = await configFileSnapshot(path)
    const observedSha256 = baseline.exists ? baseline.sha256 : null
    if (
      Object.hasOwn(options, "expectedTargetSha256") &&
      options.expectedTargetSha256 !== observedSha256
    ) {
      throw new RalphError(
        "RALPH_PROFILE_CONFIG_CONFLICT",
        "Role profile configuration changed while the command was being prepared",
        {
          exitCode: EXIT_CODES.conflict,
          file: path,
          details: {
            expectedSha256: options.expectedTargetSha256 ?? null,
            observedSha256,
          },
        },
      )
    }
    const peerBaseline = peerPath ? await configFileSnapshot(peerPath) : undefined
    if (
      peerPath &&
      peerBaseline &&
      options.peerConfigSnapshot &&
      options.peerConfigSnapshot.expectedSha256 !==
        (peerBaseline.exists ? peerBaseline.sha256 : null)
    ) {
      throw new RalphError(
        "RALPH_PROFILE_CONFIG_PEER_CONFLICT",
        "A configuration layer used to compose the role profile changed while the command was being prepared",
        {
          exitCode: EXIT_CODES.conflict,
          file: peerPath,
          details: {
            expectedSha256: options.peerConfigSnapshot.expectedSha256,
            observedSha256: peerBaseline.exists ? peerBaseline.sha256 : null,
          },
        },
      )
    }
    const exists = baseline.exists
    const layer = exists
      ? validateLayer(await readConfigDocument(path), path, {
          requireSchemaVersion: options.workspace,
        })
      : { schema_version: 1 }
    const next = structuredClone(layer)
    next.schema_version ??= 1
    const profiles = isObject(next.profiles) ? next.profiles : {}
    const previous = profiles[parsedId.data]
    if (Object.keys(parsedProfileLayer.data).length === 0) {
      delete profiles[parsedId.data]
    } else {
      profiles[parsedId.data] = structuredClone(parsedProfileLayer.data)
    }
    next.profiles = profiles
    const defaultRole = parsedProfile.data.role
    const defaultKey = defaultRole === "executor" ? "executor_profile" : "judge_profile"
    const defaults = isObject(next.defaults) ? next.defaults : {}
    const previousDefault =
      typeof defaults[defaultKey] === "string" ? defaults[defaultKey] : undefined
    if (options.setDefault) {
      defaults[defaultKey] = parsedId.data
      next.defaults = defaults
    }

    const schema = options.workspace ? RalphConfigLayerSchema : GlobalConfigLayerSchema
    const validated = schema.safeParse(next)
    if (!validated.success) {
      throw new RalphError(
        "RALPH_PROFILE_CONFIG_LAYER_INVALID",
        "The configuration layer would be invalid after updating the role profile",
        {
          exitCode: EXIT_CODES.invalidUsage,
          file: path,
          details: {
            issues: validated.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
        },
      )
    }
    const effective = await assertEffectiveCandidate(
      options.workspace ? "workspace" : "global",
      validated.data as ConfigLayer,
      options,
    )
    const scopeEffective =
      options.workspace || !options.workspaceRoot
        ? effective
        : await assertEffectiveCandidate("global", validated.data as ConfigLayer, {
            ...(options.environment ? { environment: options.environment } : {}),
          })
    if (!isDeepStrictEqual(scopeEffective.profiles[parsedId.data], parsedProfile.data)) {
      throw new RalphError(
        "RALPH_PROFILE_CONFIG_COMPOSITION_MISMATCH",
        "The partial role profile layer does not compose to the confirmed complete profile",
        {
          exitCode: EXIT_CODES.conflict,
          file: path,
          details: {
            profileId: parsedId.data,
            scope: options.workspace ? "workspace" : "global",
          },
        },
      )
    }
    // Validate the mutated scope itself as well as the active workspace overlay.
    // A workspace default must not hide an invalid global default/profile pair.
    assertProfileDefaultCompatibility(scopeEffective, parsedId.data, path)
    if (scopeEffective !== effective) {
      assertProfileDefaultCompatibility(effective, parsedId.data, path)
    }
    await options.validateEffective(scopeEffective)
    if (scopeEffective !== effective) await options.validateEffective(effective)

    await writeFileAtomic(path, stringify(validated.data, { indent: 2, lineWidth: 100 }), {
      overwrite: exists,
      mode: 0o600,
      beforeCommit: async () => {
        const observed = await configFileSnapshot(path)
        if (!sameConfigFileSnapshot(baseline, observed)) {
          throw new RalphError(
            "RALPH_PROFILE_CONFIG_CONFLICT",
            "Role profile configuration changed before the atomic commit",
            { exitCode: EXIT_CODES.conflict, file: path },
          )
        }
        if (peerPath && peerBaseline) {
          const observedPeer = await configFileSnapshot(peerPath)
          if (!sameConfigFileSnapshot(peerBaseline, observedPeer)) {
            throw new RalphError(
              "RALPH_PROFILE_CONFIG_PEER_CONFLICT",
              "A configuration layer used to validate the role profile changed before commit",
              { exitCode: EXIT_CODES.conflict, file: peerPath },
            )
          }
        }
      },
    })
    return {
      path,
      profileId: parsedId.data,
      ...(previous ? { previous: RoleProfileConfigLayerSchema.parse(previous) } : {}),
      profile: parsedProfile.data,
      created: previous === undefined && Object.keys(parsedProfileLayer.data).length > 0,
      ...(options.setDefault
        ? {
            defaultSelection: {
              role: defaultRole,
              ...(previousDefault ? { previous: previousDefault } : {}),
              profileId: parsedId.data,
            },
          }
        : {}),
    }
  })
}

export type ConfigTransferScope = "workspace" | "global"
export type ConfigTransferMutationMode = "merge" | "replace-managed" | "unset"

export type ConfigTransferChange = {
  path: string
  operation: "added" | "updated" | "removed"
}

export type ConfigTransferMutation = {
  scope: ConfigTransferScope
  mode: ConfigTransferMutationMode
  path: string
  created: boolean
  changed: boolean
  applied: boolean
  affects: "future-runs"
  changes: readonly ConfigTransferChange[]
}

type ConfigTransferCommonInput = {
  scope: ConfigTransferScope
  workspaceRoot?: string
  environment?: Record<string, string | undefined>
  dryRun: boolean
  /**
   * Binds an edit candidate to the exact target layer from which the edit was
   * prepared. `null` means that the target did not exist at preparation time.
   * Import/unset intentionally omit this and start from the latest layer.
   */
  expectedTargetSha256?: string | null
}

export type MutateConfigTransferInput = ConfigTransferCommonInput &
  (
    | {
        mode: "merge" | "replace-managed"
        candidate: unknown
      }
    | {
        mode: "unset"
        unsetPath: readonly string[]
      }
  )

const TRANSFER_MAX_DEPTH = 32
const SECRET_MATERIAL_KEY =
  /(?:api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|(?:^|[_-])token(?:$|[_-])|authorization|bearer|password|passwd|secret|private[_-]?key|session[_-]?(?:id|token)|cookie)/i
const SECRET_MATERIAL_TEXT = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/,
  /(?:^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/,
  /(?:^|[^A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{16,}/,
  /[?&](?:token|access_token|refresh_token|api_key|apikey|key|secret)=[^&\s]+/i,
] as const
const SECRET_ARGUMENT_FLAG =
  /^--?(?:api[_-]?(?:key|token)|access[_-]?(?:key|token)|refresh[_-]?token|auth[_-]?token|client[_-]?secret|session[_-]?(?:id|token)|token|password|passwd|secret|authorization|bearer|cookie|private[_-]?key)(?:=|$)/i
const REDACTION_SENTINELS = new Set(["[REDACTED]", "<redacted>", "********"])

function configSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

type ConfigFileSnapshot = { exists: false } | { exists: true; sha256: string }

async function configFileSnapshot(path: string): Promise<ConfigFileSnapshot> {
  try {
    const entry = await lstat(path)
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new RalphError(
        "RALPH_CONFIG_TARGET_UNSAFE",
        "Configuration target must be a regular non-linked file",
        { exitCode: EXIT_CODES.policyDenied, file: path },
      )
    }
    const bytes = await readFile(path)
    return { exists: true, sha256: configSha256(bytes) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false }
    throw error
  }
}

function sameConfigFileSnapshot(left: ConfigFileSnapshot, right: ConfigFileSnapshot): boolean {
  if (left.exists !== right.exists) return false
  return !left.exists || (right.exists && left.sha256 === right.sha256)
}

/** Enforce credential hygiene only in typed role profiles, never extension payloads. */
function assertProfilesContainNoSecretMaterial(layer: ConfigLayer): void {
  if (layer.profiles !== undefined) {
    assertNoSecretMaterial(layer.profiles, ["profiles"])
  }
}

function assertNoSecretMaterial(value: unknown, path: readonly string[] = [], depth = 0): void {
  if (depth > TRANSFER_MAX_DEPTH) {
    throw new RalphError(
      "RALPH_CONFIG_TRANSFER_TOO_DEEP",
      "Configuration transfer exceeds the nesting limit",
      {
        exitCode: EXIT_CODES.invalidUsage,
        details: { maximumDepth: TRANSFER_MAX_DEPTH, path: path.join(".") },
      },
    )
  }
  if (typeof value === "string") {
    const externalArgument =
      path.length >= 2 &&
      path[path.length - 2] === "args" &&
      path.includes("external_cli") &&
      SECRET_ARGUMENT_FLAG.test(value)
    if (
      externalArgument ||
      REDACTION_SENTINELS.has(value) ||
      SECRET_MATERIAL_TEXT.some((pattern) => pattern.test(value))
    ) {
      throw new RalphError(
        "RALPH_CONFIG_SECRET_MATERIAL_FORBIDDEN",
        "Configuration/profile mutation contains secret or redacted credential material",
        {
          exitCode: EXIT_CODES.policyDenied,
          details: { path: path.join(".") },
          hint: "Store the secret through `auth connect` and keep only a credential ID or env:NAME reference in config.",
        },
      )
    }
    return
  }
  if (value === null || typeof value !== "object") return
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoSecretMaterial(item, [...path, String(index)], depth + 1)
    }
    return
  }
  for (const [key, item] of Object.entries(value as ConfigLayer)) {
    const safeEnvironmentReference =
      path[path.length - 1] === "environment_refs" &&
      typeof item === "string" &&
      /^env:[A-Za-z_][A-Za-z0-9_]*$/.test(item)
    if (SECRET_MATERIAL_KEY.test(key) && !safeEnvironmentReference) {
      throw new RalphError(
        "RALPH_CONFIG_SECRET_KEY_FORBIDDEN",
        `Configuration/profile mutation cannot contain secret-bearing key: ${[...path, key].join(".")}`,
        {
          exitCode: EXIT_CODES.policyDenied,
          details: { path: [...path, key].join(".") },
          hint: "Use a typed profile credential ID or external_cli.environment_refs with env:NAME.",
        },
      )
    }
    assertNoSecretMaterial(item, [...path, key], depth + 1)
  }
}

function normalizeTransferCandidate(value: unknown, scope: ConfigTransferScope): ConfigLayer {
  if (!isObject(value)) {
    throw new RalphError(
      "RALPH_CONFIG_TRANSFER_ROOT_INVALID",
      "Configuration import/edit root must be a mapping",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  assertSafeConfigKeys(value, "configuration transfer", () => undefined)
  if (Object.hasOwn(value, "extensions")) {
    throw new RalphError(
      "RALPH_CONFIG_EXTENSIONS_IMPORT_FORBIDDEN",
      "Configuration import/edit cannot transport extension payloads",
      {
        exitCode: EXIT_CODES.policyDenied,
        hint: "Install and configure extensions through their explicit trusted command instead.",
      },
    )
  }
  const schema = scope === "workspace" ? RalphConfigLayerSchema : GlobalConfigLayerSchema
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new RalphError(
      "RALPH_CONFIG_TRANSFER_SCHEMA_INVALID",
      "Configuration import/edit contains unknown, unsafe or invalid fields",
      {
        exitCode: EXIT_CODES.invalidUsage,
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issuePath(issue).join("."),
            message: issue.message,
          })),
        },
      },
    )
  }
  const normalized = structuredClone(parsed.data) as ConfigLayer
  normalized.schema_version ??= 1
  assertNoSecretMaterial(normalized)
  return normalized
}

function configTarget(input: {
  scope: ConfigTransferScope
  workspaceRoot?: string
  environment?: Record<string, string | undefined>
}): string {
  if (input.scope === "workspace") {
    if (!input.workspaceRoot) {
      throw new RalphError(
        "RALPH_SETTINGS_WORKSPACE_REQUIRED",
        "Workspace configuration mutation requires an initialized workspace root",
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }
    return workspaceLayout(resolve(input.workspaceRoot)).config
  }
  return globalConfigPath(input.environment)
}

async function validatedLayerAt(path: string, scope: ConfigTransferScope): Promise<ConfigLayer> {
  if (!(await configPathExists(path))) return { schema_version: 1 }
  return validateLayer(await readConfigDocument(path), path, {
    requireSchemaVersion: scope === "workspace",
  })
}

export async function readConfigTransferLayer(input: {
  scope: ConfigTransferScope
  workspaceRoot?: string
  environment?: Record<string, string | undefined>
}): Promise<{
  path: string
  created: boolean
  sha256: string | null
  layer: RalphConfigLayer
}> {
  const path = configTarget(input)
  const baseline = await configFileSnapshot(path)
  const layer = await validatedLayerAt(path, input.scope)
  const observed = await configFileSnapshot(path)
  if (!sameConfigFileSnapshot(baseline, observed)) {
    throw new RalphError(
      "RALPH_CONFIG_TRANSFER_CONFLICT",
      "Configuration changed while the editable layer was being read",
      { exitCode: EXIT_CODES.conflict, file: path },
    )
  }
  layer.schema_version ??= 1
  return {
    path,
    created: !baseline.exists,
    sha256: baseline.exists ? baseline.sha256 : null,
    layer: RalphConfigLayerSchema.parse(layer),
  }
}

function deleteConfigPath(target: ConfigLayer, path: readonly string[]): boolean {
  if (path.length === 0) return false
  let parent: ConfigLayer = target
  for (const segment of path.slice(0, -1)) {
    const next = parent[segment]
    if (!isObject(next)) return false
    parent = next
  }
  const leaf = path[path.length - 1]
  if (!leaf || !Object.hasOwn(parent, leaf)) return false
  delete parent[leaf]
  return true
}

function pruneEmptyConfigParents(target: ConfigLayer, path: readonly string[]): void {
  const parents: Array<{ parent: ConfigLayer; key: string; value: ConfigLayer }> = []
  let current = target
  for (const key of path) {
    const value = current[key]
    if (!isObject(value)) return
    parents.push({ parent: current, key, value })
    current = value
  }
  for (const entry of parents.reverse()) {
    if (Object.keys(entry.value).length > 0) break
    delete entry.parent[entry.key]
  }
}

function flattenedConfigLeaves(
  value: ConfigLayer,
  prefix: readonly string[] = [],
): Map<string, string> {
  const output = new Map<string, string>()
  for (const [key, item] of Object.entries(value)) {
    const path = [...prefix, key]
    if (isObject(item) && Object.keys(item).length > 0) {
      for (const [leafPath, serialized] of flattenedConfigLeaves(item, path)) {
        output.set(leafPath, serialized)
      }
    } else {
      output.set(path.join("."), JSON.stringify(item) ?? "undefined")
    }
  }
  return output
}

function configTransferChanges(previous: ConfigLayer, next: ConfigLayer): ConfigTransferChange[] {
  const before = flattenedConfigLeaves(previous)
  const after = flattenedConfigLeaves(next)
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort((left, right) =>
    left.localeCompare(right, "en"),
  )
  return paths.flatMap((path): ConfigTransferChange[] => {
    const beforeValue = before.get(path)
    const afterValue = after.get(path)
    if (beforeValue === afterValue) return []
    return [
      {
        path,
        operation:
          beforeValue === undefined ? "added" : afterValue === undefined ? "removed" : "updated",
      },
    ]
  })
}

async function assertEffectiveCandidate(
  scope: ConfigTransferScope,
  candidate: ConfigLayer,
  input: {
    workspaceRoot?: string
    environment?: Record<string, string | undefined>
  },
): Promise<RalphConfig> {
  const effective = cloneDefaultConfig() as unknown as ConfigLayer
  if (scope === "global") {
    mergeLayer(effective, candidate)
    const workspacePath = input.workspaceRoot
      ? workspaceLayout(resolve(input.workspaceRoot)).config
      : undefined
    if (workspacePath) {
      if (await configPathExists(workspacePath)) {
        mergeLayer(
          effective,
          validateLayer(await readConfigDocument(workspacePath), workspacePath, {
            requireSchemaVersion: true,
          }),
        )
      }
    }
  } else {
    const globalPath = globalConfigPath(input.environment)
    if (await configPathExists(globalPath)) {
      mergeLayer(
        effective,
        validateLayer(await readConfigDocument(globalPath), globalPath, {
          requireSchemaVersion: false,
        }),
      )
    }
    mergeLayer(effective, candidate)
  }
  const parsed = RalphConfigSchema.safeParse(effective)
  if (!parsed.success) {
    throw new RalphError(
      "RALPH_CONFIG_TRANSFER_EFFECTIVE_INVALID",
      "Configuration mutation would produce an invalid effective configuration",
      {
        exitCode: EXIT_CODES.invalidUsage,
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      },
    )
  }
  return parsed.data
}

/**
 * Preview or atomically apply a schema-known config transfer. Import merges a
 * validated layer; edit replaces only core-managed keys while preserving any
 * already-installed extension namespace; unset removes exactly one generic
 * settings leaf and prunes now-empty parent mappings.
 */
export async function mutateConfigTransfer(
  input: MutateConfigTransferInput,
): Promise<ConfigTransferMutation> {
  const path = configTarget(input)
  const operation = async (): Promise<ConfigTransferMutation> => {
    const baseline = await configFileSnapshot(path)
    if (Object.hasOwn(input, "expectedTargetSha256")) {
      const observedSha256 = baseline.exists ? baseline.sha256 : null
      if (observedSha256 !== input.expectedTargetSha256) {
        throw new RalphError(
          "RALPH_CONFIG_TRANSFER_CONFLICT",
          "Configuration changed after the edit document was prepared",
          {
            exitCode: EXIT_CODES.conflict,
            file: path,
            details: {
              expectedSha256: input.expectedTargetSha256,
              observedSha256,
            },
          },
        )
      }
    }
    const current = await validatedLayerAt(path, input.scope)
    current.schema_version ??= 1
    let next: ConfigLayer

    if (input.mode === "unset") {
      if (
        input.unsetPath.length === 0 ||
        input.unsetPath.some(
          (segment) => !/^[a-z][a-z0-9_]*$/.test(segment) || FORBIDDEN_OBJECT_KEYS.has(segment),
        ) ||
        ["schema_version", "profiles", "extensions"].includes(input.unsetPath[0] ?? "")
      ) {
        throw new RalphError(
          "RALPH_CONFIG_UNSET_PATH_INVALID",
          "config unset accepts only one schema-known, non-profile, non-secret settings leaf",
          { exitCode: EXIT_CODES.invalidUsage, details: { path: input.unsetPath.join(".") } },
        )
      }
      next = structuredClone(current)
      deleteConfigPath(next, input.unsetPath)
      pruneEmptyConfigParents(next, input.unsetPath.slice(0, -1))
      next.schema_version = 1
    } else {
      const candidate = normalizeTransferCandidate(input.candidate, input.scope)
      if (input.mode === "merge") {
        next = structuredClone(current)
        mergeLayer(next, candidate)
      } else {
        next = { schema_version: 1 }
        for (const [key, item] of Object.entries(candidate)) {
          if (key !== "schema_version") next[key] = structuredClone(item)
        }
        if (current.extensions !== undefined) {
          next.extensions = structuredClone(current.extensions)
        }
      }
      next.schema_version = 1
    }

    const layerSchema =
      input.scope === "workspace" ? RalphConfigLayerSchema : GlobalConfigLayerSchema
    const validated = layerSchema.safeParse(next)
    if (!validated.success) {
      throw new RalphError(
        "RALPH_CONFIG_TRANSFER_LAYER_INVALID",
        "Configuration mutation would produce an invalid layer",
        {
          exitCode: EXIT_CODES.invalidUsage,
          file: path,
          details: {
            issues: validated.error.issues.map((issue) => ({
              path: issuePath(issue).join("."),
              message: issue.message,
            })),
          },
        },
      )
    }
    const normalizedNext = structuredClone(validated.data) as ConfigLayer
    normalizedNext.schema_version ??= 1
    const changes = configTransferChanges(current, normalizedNext)
    const effective = await assertEffectiveCandidate(input.scope, normalizedNext, input)
    const scopeEffective =
      input.scope === "workspace" || !input.workspaceRoot
        ? effective
        : await assertEffectiveCandidate("global", normalizedNext, {
            ...(input.environment ? { environment: input.environment } : {}),
          })
    const changedPaths = new Set(changes.map((change) => change.path))
    const changedProfileIds = new Set(
      changes.flatMap((change) => {
        const [root, profileId] = change.path.split(".")
        return root === "profiles" && profileId ? [profileId] : []
      }),
    )
    const layerDefaults = isObject(normalizedNext.defaults) ? normalizedNext.defaults : undefined
    const changedExecutorDefault = changedPaths.has("defaults.executor_profile")
      ? layerDefaults?.executor_profile
      : undefined
    const changedJudgeDefault = changedPaths.has("defaults.judge_profile")
      ? layerDefaults?.judge_profile
      : undefined
    if (typeof changedExecutorDefault === "string") {
      assertDefaultProfileRole(scopeEffective, "executor", changedExecutorDefault, path)
      if (
        scopeEffective !== effective &&
        effective.defaults.executor_profile === changedExecutorDefault
      ) {
        assertDefaultProfileRole(effective, "executor", changedExecutorDefault, path)
      }
    }
    if (typeof changedJudgeDefault === "string") {
      assertDefaultProfileRole(scopeEffective, "judge", changedJudgeDefault, path)
      if (
        scopeEffective !== effective &&
        effective.defaults.judge_profile === changedJudgeDefault
      ) {
        assertDefaultProfileRole(effective, "judge", changedJudgeDefault, path)
      }
    }
    for (const candidate of scopeEffective === effective
      ? [effective]
      : [scopeEffective, effective]) {
      for (const profileId of changedProfileIds) {
        if (candidate.defaults.executor_profile === profileId) {
          assertDefaultProfileRole(candidate, "executor", profileId, path)
        }
        if (candidate.defaults.judge_profile === profileId) {
          assertDefaultProfileRole(candidate, "judge", profileId, path)
        }
      }
    }

    if (!input.dryRun && changes.length > 0) {
      await writeFileAtomic(path, stringify(normalizedNext, { indent: 2, lineWidth: 100 }), {
        overwrite: baseline.exists,
        mode: 0o600,
        beforeCommit: async () => {
          const observed = await configFileSnapshot(path)
          if (!sameConfigFileSnapshot(baseline, observed)) {
            throw new RalphError(
              "RALPH_CONFIG_TRANSFER_CONFLICT",
              "Configuration changed after preview and before the atomic commit",
              { exitCode: EXIT_CODES.conflict, file: path },
            )
          }
        },
      })
    }

    return {
      scope: input.scope,
      mode: input.mode,
      path,
      created: !baseline.exists,
      changed: changes.length > 0,
      applied: !input.dryRun && changes.length > 0,
      affects: "future-runs",
      changes,
    }
  }
  return input.dryRun ? operation() : withConfigLock(path, operation)
}
