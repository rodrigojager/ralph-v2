import { createHash } from "node:crypto"
import { lstat, readdir, readFile, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { createOpenCodeSbomComponent, verifyOpenCodeProvenance } from "./opencode-provenance"
import {
  type BunRuntimeLicenseBinding,
  createValidatedBunRuntimeSbomComponent,
} from "./release-licenses"
import { compareUtf8Bytes } from "./release-order"

type LockWorkspace = {
  readonly name?: string
  readonly version?: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
}

type LockPackageMetadata = {
  readonly dependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly optionalPeers?: readonly string[]
}

type LockPackage = readonly [string, string?, LockPackageMetadata?, string?]

type BunTextLockfile = {
  readonly lockfileVersion?: number
  readonly workspaces?: Readonly<Record<string, LockWorkspace>>
  readonly packages?: Readonly<Record<string, LockPackage>>
}

type PackageManifest = {
  readonly name?: string
  readonly version?: string
  readonly license?: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
}

export interface CycloneDxComponent {
  readonly type: "application" | "library"
  readonly "bom-ref": string
  readonly name: string
  readonly version: string
  readonly purl?: string
  readonly hashes?: readonly { readonly alg: "SHA-512"; readonly content: string }[]
  readonly licenses: readonly { readonly expression: string }[]
  readonly properties?: readonly { readonly name: string; readonly value: string }[]
}

export interface CycloneDxBom {
  readonly bomFormat: "CycloneDX"
  readonly specVersion: "1.6"
  readonly serialNumber: string
  readonly version: 1
  readonly metadata: {
    readonly timestamp: string
    readonly component: CycloneDxComponent
    readonly tools: {
      readonly components: readonly CycloneDxComponent[]
    }
    readonly properties: readonly { readonly name: string; readonly value: string }[]
  }
  readonly components: readonly CycloneDxComponent[]
  readonly dependencies: readonly { readonly ref: string; readonly dependsOn: readonly string[] }[]
}

function removeTrailingJsonCommas(source: string): string {
  let output = ""
  let quoted = false
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? ""
    if (quoted) {
      output += character
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') {
      quoted = true
      output += character
      continue
    }
    if (character === ",") {
      let lookahead = index + 1
      while (/\s/u.test(source[lookahead] ?? "")) lookahead += 1
      if (source[lookahead] === "}" || source[lookahead] === "]") continue
    }
    output += character
  }
  if (quoted || escaped) throw new Error("bun.lock contains an unterminated JSON string")
  return output
}

function parseLocator(locator: string): { name: string; version: string } {
  const separator = locator.lastIndexOf("@")
  if (separator <= 0 || separator === locator.length - 1) {
    throw new Error(`Unsupported bun.lock package locator: ${locator}`)
  }
  return { name: locator.slice(0, separator), version: locator.slice(separator + 1) }
}

function npmPurl(name: string, version: string): string {
  const encodedName = name.startsWith("@")
    ? `%40${name.slice(1).split("/").map(encodeURIComponent).join("/")}`
    : encodeURIComponent(name)
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`
}

function sha512Hex(integrity: string | undefined): string | undefined {
  if (!integrity?.startsWith("sha512-")) return undefined
  const bytes = Buffer.from(integrity.slice("sha512-".length), "base64")
  if (bytes.byteLength !== 64)
    throw new Error(`Invalid SHA-512 integrity in bun.lock: ${integrity}`)
  return bytes.toString("hex")
}

async function readJsonManifest(path: string): Promise<PackageManifest> {
  const information = await lstat(path)
  if (
    !information.isFile() ||
    information.isSymbolicLink() ||
    information.size <= 0 ||
    information.size > 256 * 1024
  ) {
    throw new Error(`Dependency package manifest must be a regular file: ${path}`)
  }
  return JSON.parse(await readFile(path, "utf8")) as PackageManifest
}

function runtimeDependencyMap(
  manifest: Pick<PackageManifest, "dependencies" | "optionalDependencies" | "peerDependencies">,
  label: string,
): Readonly<Record<string, string>> {
  const merged: Record<string, string> = {}
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
      const previous = merged[name]
      if (previous !== undefined && previous !== specifier) {
        throw new Error(`${label} declares conflicting runtime ranges for ${name}`)
      }
      merged[name] = specifier
    }
  }
  return merged
}

function sameDependencyMap(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => compareUtf8Bytes(a, b))
  const rightEntries = Object.entries(right).sort(([a], [b]) => compareUtf8Bytes(a, b))
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries)
}

async function sourceWorkspaces(
  projectRoot: string,
): Promise<ReadonlyMap<string, PackageManifest>> {
  const output = new Map<string, PackageManifest>()
  for (const parentName of ["apps", "packages"] as const) {
    const parent = resolve(projectRoot, parentName)
    const parentInformation = await lstat(parent)
    if (!parentInformation.isDirectory() || parentInformation.isSymbolicLink()) {
      throw new Error(`Workspace inventory parent must be a regular directory: ${parent}`)
    }
    const entries = await readdir(parent, { withFileTypes: true })
    entries.sort((left, right) => compareUtf8Bytes(left.name, right.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(
          `Workspace inventory accepts regular directories only: ${resolve(parent, entry.name)}`,
        )
      }
      const manifest = await readJsonManifest(resolve(parent, entry.name, "package.json"))
      if (!manifest.name || !manifest.version) {
        throw new Error(
          `Workspace manifest requires name and version: ${resolve(parent, entry.name)}`,
        )
      }
      if (output.has(manifest.name))
        throw new Error(`Duplicate source workspace name: ${manifest.name}`)
      output.set(manifest.name, manifest)
    }
  }
  return output
}

async function installedManifest(
  bunStoreRoot: string,
  bunStoreDirectories: readonly string[],
  name: string,
  version: string,
): Promise<PackageManifest> {
  const prefix = `${name.replaceAll("/", "+")}@${version}`
  const matches = bunStoreDirectories.filter(
    (entry) => entry === prefix || entry.startsWith(`${prefix}+`),
  )
  for (const directory of matches) {
    const path = resolve(
      bunStoreRoot,
      directory,
      "node_modules",
      ...name.split("/"),
      "package.json",
    )
    try {
      const canonicalPath = await realpath(path)
      const child = relative(bunStoreRoot, canonicalPath)
      if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
        throw new Error(`Installed package manifest resolves outside Bun store: ${path}`)
      }
      const manifest = await readJsonManifest(canonicalPath)
      if (manifest.name === name && manifest.version === version) return manifest
    } catch {
      // Try the next exact-version store entry.
    }
  }
  throw new Error(`Cannot resolve installed package metadata for ${name}@${version}`)
}

function dependencyNames(metadata: LockPackageMetadata | undefined): {
  readonly required: readonly string[]
  readonly optional: readonly string[]
} {
  const peerDependencies = metadata?.peerDependencies ?? {}
  const rawOptionalPeers: unknown = metadata?.optionalPeers
  if (
    rawOptionalPeers !== undefined &&
    (!Array.isArray(rawOptionalPeers) ||
      rawOptionalPeers.some((name) => typeof name !== "string" || name.length === 0))
  ) {
    throw new Error("bun.lock package optionalPeers must be an array of non-empty names")
  }
  const optionalPeers = new Set((rawOptionalPeers as readonly string[] | undefined) ?? [])
  for (const name of optionalPeers) {
    if (!Object.hasOwn(peerDependencies, name)) {
      throw new Error(`bun.lock optional peer is absent from peerDependencies: ${name}`)
    }
  }
  return {
    required: [
      ...Object.keys(metadata?.dependencies ?? {}),
      ...Object.keys(peerDependencies).filter((name) => !optionalPeers.has(name)),
    ],
    optional: [
      ...Object.keys(metadata?.optionalDependencies ?? {}),
      ...Object.keys(peerDependencies).filter((name) => optionalPeers.has(name)),
    ],
  }
}

function hasInstalledStoreEntry(
  bunStoreDirectories: readonly string[],
  name: string,
  version: string,
): boolean {
  const prefix = `${name.replaceAll("/", "+")}@${version}`
  return bunStoreDirectories.some((entry) => entry === prefix || entry.startsWith(`${prefix}+`))
}

function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value)
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("SBOM canonical JSON rejects non-finite numbers")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`
  if (typeof value === "object") {
    const entries = Object.entries(value as Readonly<Record<string, unknown>>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareUtf8Bytes(left, right))
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`
  }
  throw new Error(`SBOM canonical JSON rejects value type: ${typeof value}`)
}

export async function createReleaseSbom(input: {
  readonly projectRoot: string
  readonly applicationName?: string
  readonly version: string
  readonly licenseExpression: string
  readonly publishedAt: string
  readonly sourceFingerprintSha256: string
  readonly bunRuntime?: BunRuntimeLicenseBinding
}): Promise<CycloneDxBom> {
  const projectRoot = resolve(input.projectRoot)
  const lockPath = resolve(projectRoot, "bun.lock")
  const lockInformation = await lstat(lockPath)
  if (!lockInformation.isFile() || lockInformation.isSymbolicLink()) {
    throw new Error(`Release SBOM requires a regular bun.lock: ${lockPath}`)
  }
  const lock = JSON.parse(
    removeTrailingJsonCommas(await readFile(lockPath, "utf8")),
  ) as BunTextLockfile
  if (lock.lockfileVersion !== 1 || !lock.workspaces || !lock.packages) {
    throw new Error("Release SBOM supports only the committed Bun text lockfile schema v1")
  }

  const workspacesByName = new Map<string, LockWorkspace>()
  for (const workspace of Object.values(lock.workspaces)) {
    if (!workspace.name) continue
    if (workspacesByName.has(workspace.name)) {
      throw new Error(`Duplicate bun.lock workspace name: ${workspace.name}`)
    }
    workspacesByName.set(workspace.name, workspace)
  }
  const workspacesFromSource = await sourceWorkspaces(projectRoot)
  const workspaceQueue = ["ralph-next", "@ralph-next/launcher"]
  const visitedWorkspaces = new Set<string>()
  const requiredExternalNames = new Set<string>()
  const optionalExternalNames = new Set<string>()
  while (workspaceQueue.length > 0) {
    const name = workspaceQueue.shift()
    if (!name || visitedWorkspaces.has(name)) continue
    const workspace = workspacesByName.get(name)
    const sourceWorkspace = workspacesFromSource.get(name)
    if (!workspace || !sourceWorkspace) {
      throw new Error(`Release workspace must exist in both source and bun.lock: ${name}`)
    }
    const sourceDependencies = runtimeDependencyMap(sourceWorkspace, `Source workspace ${name}`)
    const lockedDependencies = runtimeDependencyMap(workspace, `Locked workspace ${name}`)
    if (
      workspace.version !== sourceWorkspace.version ||
      !sameDependencyMap(sourceDependencies, lockedDependencies)
    ) {
      throw new Error(
        `Source workspace differs from bun.lock; regenerate the lockfile before release: ${name}`,
      )
    }
    visitedWorkspaces.add(name)
    const requiredSourceNames = new Set([
      ...Object.keys(sourceWorkspace.dependencies ?? {}),
      ...Object.keys(sourceWorkspace.peerDependencies ?? {}),
    ])
    for (const [dependency, specifier] of Object.entries(sourceDependencies)) {
      if (specifier.startsWith("workspace:")) workspaceQueue.push(dependency)
      else if (requiredSourceNames.has(dependency)) requiredExternalNames.add(dependency)
      else optionalExternalNames.add(dependency)
    }
  }

  const packages = Object.entries(lock.packages).map(([key, value]) => {
    if (!Array.isArray(value) || typeof value[0] !== "string") {
      throw new Error(`Invalid bun.lock package record: ${key}`)
    }
    const locator = parseLocator(value[0])
    return { key, locator, metadata: value[2], integrity: value[3] }
  })
  const packagesByName = new Map<string, typeof packages>()
  for (const entry of packages) {
    const current = packagesByName.get(entry.locator.name) ?? []
    current.push(entry)
    packagesByName.set(entry.locator.name, current)
  }

  const bunStore = resolve(projectRoot, "node_modules", ".bun")
  const bunStoreInformation = await lstat(bunStore)
  if (!bunStoreInformation.isDirectory() || bunStoreInformation.isSymbolicLink()) {
    throw new Error(`Release SBOM requires an installed immutable Bun store: ${bunStore}`)
  }
  const canonicalBunStore = await realpath(bunStore)
  const storeRelative = relative(projectRoot, canonicalBunStore)
  if (
    storeRelative === "" ||
    storeRelative === ".." ||
    storeRelative.startsWith(`..${sep}`) ||
    isAbsolute(storeRelative)
  ) {
    throw new Error(`Bun store resolves outside the release project: ${bunStore}`)
  }
  const bunStoreDirectories = (await readdir(canonicalBunStore, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort(compareUtf8Bytes)

  const selected = new Map<string, (typeof packages)[number]>()
  const selectedManifests = new Map<string, PackageManifest>()
  const externalQueue = [
    ...[...requiredExternalNames].map((name) => ({ name, optional: false })),
    ...[...optionalExternalNames].map((name) => ({ name, optional: true })),
  ]
  while (externalQueue.length > 0) {
    const queued = externalQueue.shift()
    if (!queued) continue
    const candidates = packagesByName.get(queued.name)
    if (!candidates || candidates.length === 0) {
      if (queued.optional) continue
      throw new Error(`Runtime dependency is absent from bun.lock packages: ${queued.name}`)
    }
    for (const candidate of candidates) {
      const identity = `${candidate.locator.name}@${candidate.locator.version}`
      if (selected.has(identity)) continue
      if (
        queued.optional &&
        !hasInstalledStoreEntry(
          bunStoreDirectories,
          candidate.locator.name,
          candidate.locator.version,
        )
      ) {
        continue
      }
      const manifest = await installedManifest(
        canonicalBunStore,
        bunStoreDirectories,
        candidate.locator.name,
        candidate.locator.version,
      )
      selected.set(identity, candidate)
      selectedManifests.set(identity, manifest)
      const names = dependencyNames(candidate.metadata)
      externalQueue.push(
        ...names.required.map((name) => ({ name, optional: false })),
        ...names.optional.map((name) => ({ name, optional: true })),
      )
    }
  }

  const components: CycloneDxComponent[] = []
  for (const entry of [...selected.values()].sort((left, right) => {
    const name = compareUtf8Bytes(left.locator.name, right.locator.name)
    return name !== 0 ? name : compareUtf8Bytes(left.locator.version, right.locator.version)
  })) {
    const identity = `${entry.locator.name}@${entry.locator.version}`
    const manifest = selectedManifests.get(identity)
    if (!manifest) throw new Error(`Selected runtime dependency lost its manifest: ${identity}`)
    if (!manifest.license?.trim()) {
      throw new Error(
        `Dependency has no explicit installed license metadata: ${entry.locator.name}@${entry.locator.version}`,
      )
    }
    const purl = npmPurl(entry.locator.name, entry.locator.version)
    const hash = sha512Hex(entry.integrity)
    components.push({
      type: "library",
      "bom-ref": purl,
      name: entry.locator.name,
      version: entry.locator.version,
      purl,
      ...(hash ? { hashes: [{ alg: "SHA-512", content: hash }] } : {}),
      licenses: [{ expression: manifest.license.trim() }],
      properties: [
        { name: "ralph:bun-lock-key", value: entry.key },
        { name: "ralph:license-source", value: "installed-package-manifest" },
      ],
    })
  }

  const openCode = await verifyOpenCodeProvenance(projectRoot)
  components.push(createOpenCodeSbomComponent(openCode))
  const bunRuntime = input.bunRuntime
    ? await createValidatedBunRuntimeSbomComponent(projectRoot, input.bunRuntime)
    : undefined
  if (bunRuntime) components.push(bunRuntime)

  const applicationName = input.applicationName ?? "ralph-next"
  const applicationRef = npmPurl(applicationName, input.version)
  const application: CycloneDxComponent = {
    type: "application",
    "bom-ref": applicationRef,
    name: applicationName,
    version: input.version,
    purl: applicationRef,
    licenses: [{ expression: input.licenseExpression }],
  }
  const dependencies = [
    {
      ref: applicationRef,
      dependsOn: [
        ...components
          .filter((component) => component.purl?.startsWith("pkg:npm/") === true)
          .map((component) => component["bom-ref"]),
        ...(bunRuntime ? [bunRuntime["bom-ref"]] : []),
      ].sort(compareUtf8Bytes),
    },
  ]

  const metadata: CycloneDxBom["metadata"] = {
    timestamp: input.publishedAt,
    component: application,
    tools: {
      components: [
        {
          type: "application",
          "bom-ref": "ralph:release-packager",
          name: "ralph-v2-release-packager",
          version: input.version,
          licenses: [{ expression: input.licenseExpression }],
        },
      ],
    },
    properties: [
      { name: "ralph:source-fingerprint-sha256", value: input.sourceFingerprintSha256 },
      { name: "ralph:bun-lockfile-version", value: String(lock.lockfileVersion) },
      { name: "ralph:dependency-resolution", value: "conservative-lock-runtime-inventory" },
      { name: "ralph:dependency-edges", value: "root-to-declared-runtime-components" },
      {
        name: "ralph:bun-runtime-distribution",
        value: bunRuntime ? "embedded-and-locally-curated" : "not-embedded-host-runtime-required",
      },
      { name: "ralph:launcher-workspace-source", value: "apps/ralph-launcher/package.json" },
    ],
  }
  const serialSeed = canonicalJson({
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata,
    components,
    dependencies,
  })
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${deterministicUuid(serialSeed)}`,
    version: 1,
    metadata,
    components,
    dependencies,
  }
}
