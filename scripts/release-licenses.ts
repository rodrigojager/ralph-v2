import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { sha256File } from "./build-artifact"
import { assertOpenCodeSbomComponent, verifyOpenCodeProvenance } from "./opencode-provenance"
import { copyRegularVerified } from "./release-files"
import { compareUtf8Bytes } from "./release-order"
import type { CycloneDxBom, CycloneDxComponent } from "./release-sbom"

const MAX_COMPONENTS = 1_024
const MAX_TEXT_FILES_PER_COMPONENT = 16
const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024
const MAX_LICENSE_INVENTORY_BYTES = 64 * 1024 * 1024
const MAX_CURATION_FILES = 32
const MAX_CURATION_FILE_BYTES = 8 * 1024 * 1024
const MAX_CURATION_BYTES = 32 * 1024 * 1024
const MAX_CURATION_MANIFEST_BYTES = 512 * 1024
const BUN_REPOSITORY = "https://github.com/oven-sh/bun"
const BUN_COMPLETE_SCOPE = "license-notice-provenance-for-pinned-runtime"
const BUN_COMPONENT_NAME = "bun-runtime"
const BUN_CURATION_LICENSE_REF_PREFIX = "LicenseRef-Bun-Runtime-Curation-"
const BUN_REVISION_PATTERN = /^[0-9a-f]{40}$/u
const SEMVER_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const LICENSE_FILE_PATTERN = /^(?:licen[cs]e|copying)(?:[._-].+)?$/iu
const NOTICE_FILE_PATTERN = /^notice(?:[._-].+)?$/iu
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu

function containsC0OrDeleteControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true
  }
  return false
}

type LicenseFileKind = "license" | "copying" | "notice" | "provenance" | "curation-manifest"

type InspectedFile = {
  readonly source: string
  readonly sourceName: string
  readonly kind: LicenseFileKind
  readonly sizeBytes: number
  readonly sha256: string
}

type MaterializedFile = {
  readonly path: string
  readonly sourceName: string
  readonly kind: LicenseFileKind
  readonly sizeBytes: number
  readonly sha256: string
}

type LicenseInventoryComponent = {
  readonly bomRef: string
  readonly name: string
  readonly version: string
  readonly licenseExpression?: string
  readonly sourceKind: "bun-store" | "curated-source" | "bun-runtime"
  readonly sourceRevision?: string
  readonly files: readonly MaterializedFile[]
}

export interface BunRuntimeLicenseBinding {
  readonly version: string
  readonly revision: string
}

export interface ReleaseLicenseInventoryReceipt {
  readonly rootDirectory: string
  readonly manifestPath: string
  readonly manifestSha256: string
  readonly totalFiles: number
  readonly totalBytes: number
}

type BunCurationFile = {
  readonly path: string
  readonly kind: "license" | "copying" | "notice" | "provenance"
  readonly sizeBytes: number
  readonly sha256: string
}

type BunCurationManifest = {
  readonly schemaVersion: 1
  readonly runtime: "bun"
  readonly version: string
  readonly revision: string
  readonly sourceRepository: typeof BUN_REPOSITORY
  readonly sourceRevision: string
  readonly completeScope: typeof BUN_COMPLETE_SCOPE
  readonly curatedAt: string
  readonly curatedBy: string
  readonly files: readonly BunCurationFile[]
}

type ValidatedBunRuntimeCuration = {
  readonly binding: BunRuntimeLicenseBinding
  readonly sourceRoot: string
  readonly manifest: BunCurationManifest
  readonly manifestFile: InspectedFile
  readonly files: readonly {
    readonly receipt: BunCurationFile
    readonly inspected: InspectedFile
  }[]
}

type PackageManifest = {
  readonly name?: unknown
  readonly version?: unknown
  readonly license?: unknown
}

function inside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate)
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

function portable(path: string): string {
  return path.replaceAll("\\", "/")
}

function npmPurl(name: string, version: string): string {
  const encodedName = name.startsWith("@")
    ? `%40${name.slice(1).split("/").map(encodeURIComponent).join("/")}`
    : encodeURIComponent(name)
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`
}

function assertPortableSegment(segment: string, label: string): void {
  if (
    segment !== segment.normalize("NFC") ||
    segment === "" ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    containsC0OrDeleteControl(segment) ||
    /[<>:"|?*]/u.test(segment) ||
    segment.endsWith(".") ||
    segment.endsWith(" ") ||
    WINDOWS_RESERVED_SEGMENT.test(segment)
  ) {
    throw new Error(`${label} contains an unsafe portable path segment: ${segment}`)
  }
}

function assertPortableRelativePath(path: string, label: string): readonly string[] {
  if (
    path.length === 0 ||
    path.length > 512 ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    isAbsolute(path)
  ) {
    throw new Error(`${label} must be a bounded portable relative path: ${path}`)
  }
  const segments = path.split("/")
  if (segments.length > 8) throw new Error(`${label} exceeds the maximum path depth: ${path}`)
  for (const segment of segments) assertPortableSegment(segment, label)
  return segments
}

function licenseExpression(component: CycloneDxComponent): string {
  if (
    component.licenses.length !== 1 ||
    typeof component.licenses[0]?.expression !== "string" ||
    component.licenses[0].expression.trim().length === 0
  ) {
    throw new Error(
      `SBOM component must declare exactly one license expression: ${component["bom-ref"]}`,
    )
  }
  return component.licenses[0].expression.trim()
}

function componentDirectory(component: CycloneDxComponent): string {
  const identity = `${component.name}@${component.version}`
  const readable = identity
    .normalize("NFC")
    .replace(/^@/u, "")
    .replaceAll("/", "+")
    .replace(/[^0-9A-Za-z._+@-]+/gu, "-")
    .slice(0, 96)
    .replace(/[. ]+$/u, "")
  const suffix = createHash("sha256").update(component["bom-ref"]).digest("hex").slice(0, 16)
  const segment = `${readable || "component"}--${suffix}`
  assertPortableSegment(segment, "License inventory component")
  return segment
}

function classifiedFileName(name: string): LicenseFileKind | undefined {
  if (NOTICE_FILE_PATTERN.test(name)) return "notice"
  if (LICENSE_FILE_PATTERN.test(name)) {
    return name.toLocaleLowerCase("en-US").startsWith("copying") ? "copying" : "license"
  }
  return undefined
}

async function inspectBoundedTextFile(
  sourcePath: string,
  kind: LicenseFileKind,
  maximumBytes = MAX_TEXT_FILE_BYTES,
): Promise<InspectedFile> {
  const source = resolve(sourcePath)
  const before = await lstat(source).catch(() => undefined)
  if (
    !before?.isFile() ||
    before.isSymbolicLink() ||
    before.size <= 0 ||
    before.size > maximumBytes
  ) {
    throw new Error(`License material must be a bounded regular non-empty file: ${source}`)
  }
  const handle = await open(source, "r")
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs ||
      opened.ctimeMs !== before.ctimeMs
    ) {
      throw new Error(`License material changed before it could be read: ${source}`)
    }
    const bytes = await handle.readFile()
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    if (decoded.trim().length === 0) throw new Error(`License material cannot be blank: ${source}`)
    const after = await handle.stat()
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(`License material changed while it was read: ${source}`)
    }
    return {
      source,
      sourceName: source.slice(Math.max(source.lastIndexOf("/"), source.lastIndexOf("\\")) + 1),
      kind,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }
  } finally {
    await handle.close()
  }
}

async function readBoundedJson(
  path: string,
  label: string,
  maximumBytes: number,
): Promise<unknown> {
  const source = resolve(path)
  const before = await lstat(source).catch(() => undefined)
  if (
    !before?.isFile() ||
    before.isSymbolicLink() ||
    before.size <= 0 ||
    before.size > maximumBytes
  ) {
    throw new Error(`${label} must be a bounded regular non-empty file: ${source}`)
  }
  const handle = await open(source, "r")
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs ||
      opened.ctimeMs !== before.ctimeMs
    ) {
      throw new Error(`${label} changed before it could be read: ${source}`)
    }
    const bytes = await handle.readFile()
    const settled = await handle.stat()
    if (
      settled.dev !== opened.dev ||
      settled.ino !== opened.ino ||
      settled.size !== opened.size ||
      settled.mtimeMs !== opened.mtimeMs ||
      settled.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(`${label} changed while it was read: ${source}`)
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch (error) {
    throw new Error(`${label} must be bounded UTF-8 JSON: ${path}`, { cause: error })
  } finally {
    await handle.close()
  }
}

async function packageLicenseFiles(packageRoot: string): Promise<readonly InspectedFile[]> {
  const entries = await readdir(packageRoot, { withFileTypes: true })
  entries.sort((left, right) => compareUtf8Bytes(left.name, right.name))
  const matching = entries.filter((entry) => classifiedFileName(entry.name) !== undefined)
  if (matching.length === 0 || matching.length > MAX_TEXT_FILES_PER_COMPONENT) {
    throw new Error(
      `Installed package must contain 1-${MAX_TEXT_FILES_PER_COMPONENT} top-level LICENSE/COPYING/NOTICE files: ${packageRoot}`,
    )
  }
  const caseFolded = new Set<string>()
  const files: InspectedFile[] = []
  for (const entry of matching) {
    const folded = entry.name.toLocaleLowerCase("en-US")
    if (caseFolded.has(folded)) {
      throw new Error(`License filenames collide on case-insensitive filesystems: ${packageRoot}`)
    }
    caseFolded.add(folded)
    const path = resolve(packageRoot, entry.name)
    const information = await lstat(path)
    if (information.isSymbolicLink() || !information.isFile()) {
      throw new Error(`Matching license material must be a regular file: ${path}`)
    }
    files.push(await inspectBoundedTextFile(path, classifiedFileName(entry.name) ?? "notice"))
  }
  if (!files.some((file) => file.kind === "license" || file.kind === "copying")) {
    throw new Error(
      `Installed package has NOTICE material but no LICENSE/COPYING text: ${packageRoot}`,
    )
  }
  return files
}

function fileInventoryIdentity(files: readonly InspectedFile[]): string {
  return JSON.stringify(
    files.map((file) => ({
      name: file.sourceName,
      kind: file.kind,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
    })),
  )
}

async function canonicalBunStore(projectRoot: string): Promise<{
  readonly root: string
  readonly directories: readonly string[]
}> {
  const requested = resolve(projectRoot, "node_modules", ".bun")
  const information = await lstat(requested).catch(() => undefined)
  if (!information?.isDirectory() || information.isSymbolicLink()) {
    throw new Error(`License inventory requires a regular installed Bun store: ${requested}`)
  }
  const root = await realpath(requested)
  const child = relative(projectRoot, root)
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`Installed Bun store resolves outside the project: ${requested}`)
  }
  const entries = await readdir(root, { withFileTypes: true })
  const directories: string[] = []
  for (const entry of entries) {
    if (entry.isSymbolicLink())
      throw new Error(`Bun store contains a symlink entry: ${resolve(root, entry.name)}`)
    if (entry.isDirectory()) directories.push(entry.name)
  }
  directories.sort(compareUtf8Bytes)
  return { root, directories }
}

async function exactInstalledPackageVariants(
  store: Awaited<ReturnType<typeof canonicalBunStore>>,
  component: CycloneDxComponent,
): Promise<readonly { readonly root: string; readonly files: readonly InspectedFile[] }[]> {
  const prefix = `${component.name.replaceAll("/", "+")}@${component.version}`
  const candidates = store.directories.filter(
    (directory) => directory === prefix || directory.startsWith(`${prefix}+`),
  )
  if (candidates.length === 0) {
    throw new Error(
      `Cannot locate exact installed package for SBOM component: ${component.name}@${component.version}`,
    )
  }
  const variants: { root: string; files: readonly InspectedFile[] }[] = []
  for (const directory of candidates) {
    const requestedRoot = resolve(
      store.root,
      directory,
      "node_modules",
      ...component.name.split("/"),
    )
    const information = await lstat(requestedRoot).catch(() => undefined)
    if (!information?.isDirectory() || information.isSymbolicLink()) {
      throw new Error(
        `Exact Bun store package variant is not a regular directory: ${requestedRoot}`,
      )
    }
    const root = await realpath(requestedRoot)
    if (!inside(store.root, root)) {
      throw new Error(
        `Exact Bun store package variant resolves outside the store: ${requestedRoot}`,
      )
    }
    const manifest = (await readBoundedJson(
      resolve(root, "package.json"),
      "Installed dependency manifest",
      256 * 1024,
    )) as PackageManifest
    const expression = licenseExpression(component)
    if (
      manifest.name !== component.name ||
      manifest.version !== component.version ||
      typeof manifest.license !== "string" ||
      manifest.license.trim() !== expression
    ) {
      throw new Error(
        `Installed package metadata does not match its SBOM component: ${component["bom-ref"]}`,
      )
    }
    variants.push({ root, files: await packageLicenseFiles(root) })
  }
  const expected = fileInventoryIdentity(variants[0]?.files ?? [])
  for (const variant of variants.slice(1)) {
    if (fileInventoryIdentity(variant.files) !== expected) {
      throw new Error(
        `Peer variants disagree on license/notice texts for ${component.name}@${component.version}`,
      )
    }
  }
  return variants
}

async function copyInspectedFiles(
  files: readonly InspectedFile[],
  destinationRoot: string,
  inventoryRoot: string,
): Promise<readonly MaterializedFile[]> {
  await mkdir(destinationRoot, { recursive: true })
  const output: MaterializedFile[] = []
  for (const file of files) {
    assertPortableSegment(file.sourceName, "License material filename")
    const destination = resolve(destinationRoot, file.sourceName)
    const receipt = await copyRegularVerified(file.source, destination, {
      expectedSha256: file.sha256,
    })
    if (receipt.sizeBytes !== file.sizeBytes) {
      throw new Error(`Copied license material changed size: ${file.source}`)
    }
    output.push({
      path: portable(relative(inventoryRoot, destination)),
      sourceName: file.sourceName,
      kind: file.kind,
      sizeBytes: receipt.sizeBytes,
      sha256: receipt.sha256,
    })
  }
  return output
}

function canonicalComponent(component: CycloneDxComponent): string {
  function serialize(value: unknown): string {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return JSON.stringify(value)
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("SBOM component contains a non-finite number")
      return JSON.stringify(value)
    }
    if (Array.isArray(value)) return `[${value.map((entry) => serialize(entry)).join(",")}]`
    if (typeof value === "object") {
      const entries = Object.entries(value as Readonly<Record<string, unknown>>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => compareUtf8Bytes(left, right))
      return `{${entries
        .map(([key, entry]) => `${JSON.stringify(key)}:${serialize(entry)}`)
        .join(",")}}`
    }
    throw new Error(`SBOM component contains unsupported value type: ${typeof value}`)
  }
  return serialize(component)
}

function npmComponentsFromExactRootGraph(
  sbom: CycloneDxBom,
  expectedBunRuntime?: CycloneDxComponent,
): readonly CycloneDxComponent[] {
  if (sbom.components.length > MAX_COMPONENTS) {
    throw new Error(`Release SBOM exceeds the bounded component limit of ${MAX_COMPONENTS}`)
  }
  const refs = new Set<string>()
  const npm: CycloneDxComponent[] = []
  const bunRuntime: CycloneDxComponent[] = []
  let openCodeComponents = 0
  for (const component of sbom.components) {
    if (refs.has(component["bom-ref"])) {
      throw new Error(`Release SBOM contains a duplicate component: ${component["bom-ref"]}`)
    }
    refs.add(component["bom-ref"])
    licenseExpression(component)
    if (component.purl?.startsWith("pkg:npm/") === true) {
      if (
        component.type !== "library" ||
        component.purl !== component["bom-ref"] ||
        component.purl !== npmPurl(component.name, component.version)
      ) {
        throw new Error(
          `npm SBOM component bom-ref/purl must encode its exact name and version: ${component["bom-ref"]}`,
        )
      }
      npm.push(component)
    } else if (component.name === "opencode-curated-source") {
      if (component.type !== "library") {
        throw new Error("Curated OpenCode SBOM component must be a library")
      }
      openCodeComponents += 1
    } else if (
      component.name === BUN_COMPONENT_NAME ||
      component["bom-ref"].startsWith("runtime:bun@")
    ) {
      if (component.type !== "application") {
        throw new Error("Embedded Bun SBOM component must be an application")
      }
      bunRuntime.push(component)
    } else {
      throw new Error(
        `Unknown non-npm release component has no curated license adapter: ${component["bom-ref"]}`,
      )
    }
  }
  if (openCodeComponents !== 1) {
    throw new Error("Release SBOM must contain exactly one curated OpenCode source component")
  }
  if (expectedBunRuntime) {
    if (
      bunRuntime.length !== 1 ||
      canonicalComponent(bunRuntime[0] as CycloneDxComponent) !==
        canonicalComponent(expectedBunRuntime)
    ) {
      throw new Error(
        "Standalone release SBOM Bun component does not exactly match validated local curation",
      )
    }
  } else if (bunRuntime.length !== 0) {
    throw new Error("npm release SBOM must not claim an embedded Bun runtime")
  }
  const bunDistribution = sbom.metadata.properties.filter(
    (property) => property.name === "ralph:bun-runtime-distribution",
  )
  const expectedDistribution = expectedBunRuntime
    ? "embedded-and-locally-curated"
    : "not-embedded-host-runtime-required"
  if (bunDistribution.length !== 1 || bunDistribution[0]?.value !== expectedDistribution) {
    throw new Error(
      expectedBunRuntime
        ? "Standalone release SBOM must declare its locally curated embedded Bun runtime"
        : "npm release SBOM must not claim an embedded Bun runtime",
    )
  }
  const rootDependencyRecords = sbom.dependencies.filter(
    (dependency) => dependency.ref === sbom.metadata.component["bom-ref"],
  )
  if (sbom.dependencies.length !== 1 || rootDependencyRecords.length !== 1) {
    throw new Error(
      "Release license inventory requires one exact root-to-runtime SBOM dependency record",
    )
  }
  const declared = rootDependencyRecords[0]?.dependsOn ?? []
  if (new Set(declared).size !== declared.length) {
    throw new Error("Release SBOM root dependency graph contains duplicate component refs")
  }
  const expected = [
    ...npm.map((component) => component["bom-ref"]),
    ...(expectedBunRuntime ? [expectedBunRuntime["bom-ref"]] : []),
  ].sort(compareUtf8Bytes)
  const actual = [...declared].sort(compareUtf8Bytes)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      "Release SBOM root dependency graph does not exactly match declared runtime components",
    )
  }
  return npm.sort((left, right) => compareUtf8Bytes(left["bom-ref"], right["bom-ref"]))
}

async function materializeNpmComponent(
  store: Awaited<ReturnType<typeof canonicalBunStore>>,
  component: CycloneDxComponent,
  inventoryRoot: string,
): Promise<LicenseInventoryComponent> {
  const variants = await exactInstalledPackageVariants(store, component)
  const selected = variants[0]
  if (!selected)
    throw new Error(`Installed package variant selection became empty: ${component["bom-ref"]}`)
  const files = await copyInspectedFiles(
    selected.files,
    resolve(inventoryRoot, "npm", componentDirectory(component)),
    inventoryRoot,
  )
  return {
    bomRef: component["bom-ref"],
    name: component.name,
    version: component.version,
    licenseExpression: licenseExpression(component),
    sourceKind: "bun-store",
    files,
  }
}

async function materializeOpenCode(
  projectRoot: string,
  component: CycloneDxComponent,
  inventoryRoot: string,
): Promise<LicenseInventoryComponent> {
  const provenance = await verifyOpenCodeProvenance(projectRoot)
  assertOpenCodeSbomComponent(component, provenance)
  const requestedSourceRoot = resolve(projectRoot, "third_party", "opencode")
  const sourceInformation = await lstat(requestedSourceRoot).catch(() => undefined)
  if (!sourceInformation?.isDirectory() || sourceInformation.isSymbolicLink()) {
    throw new Error(`Curated OpenCode source must be a regular directory: ${requestedSourceRoot}`)
  }
  const sourceRoot = await realpath(requestedSourceRoot)
  if (!inside(projectRoot, sourceRoot)) {
    throw new Error(
      `Curated OpenCode source resolves outside the release project: ${requestedSourceRoot}`,
    )
  }
  const required = [
    "LICENSE",
    "PROVENANCE.json",
    "UPSTREAM.md",
    "copied-files.md",
    "patches.md",
  ] as const
  const inspected: InspectedFile[] = []
  for (const name of required) {
    inspected.push(
      await inspectBoundedTextFile(
        resolve(sourceRoot, name),
        name === "LICENSE" ? "license" : "provenance",
      ),
    )
  }
  const files = await copyInspectedFiles(
    inspected,
    resolve(inventoryRoot, "curated", "opencode"),
    inventoryRoot,
  )
  return {
    bomRef: component["bom-ref"],
    name: component.name,
    version: component.version,
    licenseExpression: licenseExpression(component),
    sourceKind: "curated-source",
    files,
  }
}

function boundedString(value: unknown, label: string, maximum = 512): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    containsC0OrDeleteControl(value)
  ) {
    throw new Error(`${label} must be a bounded non-control string`)
  }
  return value
}

function parseBunCurationManifest(
  value: unknown,
  binding: BunRuntimeLicenseBinding,
): BunCurationManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Bun runtime CURATION.json must be an object")
  }
  const record = value as Readonly<Record<string, unknown>>
  const allowed = new Set([
    "schemaVersion",
    "runtime",
    "version",
    "revision",
    "sourceRepository",
    "sourceRevision",
    "completeScope",
    "curatedAt",
    "curatedBy",
    "files",
  ])
  for (const key of Object.keys(record)) {
    if (!allowed.has(key))
      throw new Error(`Bun runtime CURATION.json contains an unknown field: ${key}`)
  }
  if (
    record.schemaVersion !== 1 ||
    record.runtime !== "bun" ||
    record.version !== binding.version ||
    record.revision !== binding.revision ||
    record.sourceRepository !== BUN_REPOSITORY ||
    record.sourceRevision !== binding.revision ||
    record.completeScope !== BUN_COMPLETE_SCOPE
  ) {
    throw new Error(
      "Bun runtime CURATION.json does not bind the exact runtime/version/revision and complete scope",
    )
  }
  const curatedAt = boundedString(record.curatedAt, "Bun runtime curatedAt")
  if (!Number.isFinite(Date.parse(curatedAt)) || new Date(curatedAt).toISOString() !== curatedAt) {
    throw new Error("Bun runtime curatedAt must be a canonical ISO-8601 timestamp")
  }
  const curatedBy = boundedString(record.curatedBy, "Bun runtime curatedBy", 256)
  if (
    !Array.isArray(record.files) ||
    record.files.length === 0 ||
    record.files.length > MAX_CURATION_FILES
  ) {
    throw new Error(`Bun runtime curation must declare 1-${MAX_CURATION_FILES} files`)
  }
  const files: BunCurationFile[] = []
  const paths = new Set<string>()
  const portablePaths = new Set<string>(["curation.json"])
  for (const entry of record.files) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Bun runtime curation file entry must be an object")
    }
    const file = entry as Readonly<Record<string, unknown>>
    if (Object.keys(file).some((key) => !["path", "kind", "sizeBytes", "sha256"].includes(key))) {
      throw new Error("Bun runtime curation file entry contains an unknown field")
    }
    const path = boundedString(file.path, "Bun runtime curation path")
    assertPortableRelativePath(path, "Bun runtime curation path")
    const foldedPath = path.toLocaleLowerCase("en-US")
    const hasPortableCollision = [...portablePaths].some(
      (existing) =>
        existing === foldedPath ||
        existing.startsWith(`${foldedPath}/`) ||
        foldedPath.startsWith(`${existing}/`),
    )
    if (path === "CURATION.json" || paths.has(path) || hasPortableCollision) {
      throw new Error(`Bun runtime curation path is reserved or duplicated: ${path}`)
    }
    paths.add(path)
    portablePaths.add(foldedPath)
    if (!(["license", "copying", "notice", "provenance"] as const).includes(file.kind as never)) {
      throw new Error(`Bun runtime curation file has unsupported kind: ${String(file.kind)}`)
    }
    if (
      !Number.isSafeInteger(file.sizeBytes) ||
      (file.sizeBytes as number) <= 0 ||
      (file.sizeBytes as number) > MAX_CURATION_FILE_BYTES
    ) {
      throw new Error(`Bun runtime curation file has invalid bounded size: ${path}`)
    }
    if (typeof file.sha256 !== "string" || !SHA256_PATTERN.test(file.sha256)) {
      throw new Error(`Bun runtime curation file has invalid SHA-256: ${path}`)
    }
    files.push({
      path,
      kind: file.kind as BunCurationFile["kind"],
      sizeBytes: file.sizeBytes as number,
      sha256: file.sha256,
    })
  }
  files.sort((left, right) => compareUtf8Bytes(left.path, right.path))
  if (!files.some((file) => file.kind === "license" || file.kind === "copying")) {
    throw new Error("Bun runtime curation must include at least one LICENSE/COPYING text")
  }
  if (!files.some((file) => file.kind === "provenance")) {
    throw new Error("Bun runtime curation must include at least one provenance file")
  }
  const total = files.reduce((sum, file) => sum + file.sizeBytes, 0)
  if (total > MAX_CURATION_BYTES) {
    throw new Error(`Bun runtime curation exceeds ${MAX_CURATION_BYTES} bytes`)
  }
  return {
    schemaVersion: 1,
    runtime: "bun",
    version: binding.version,
    revision: binding.revision,
    sourceRepository: BUN_REPOSITORY,
    sourceRevision: binding.revision,
    completeScope: BUN_COMPLETE_SCOPE,
    curatedAt,
    curatedBy,
    files,
  }
}

async function enumerateRegularTree(root: string, current = root): Promise<readonly string[]> {
  const output: string[] = []
  const entries = await readdir(current, { withFileTypes: true })
  entries.sort((left, right) => compareUtf8Bytes(left.name, right.name))
  for (const entry of entries) {
    const path = resolve(current, entry.name)
    if (!inside(root, path)) throw new Error(`Bun runtime curation escaped its root: ${path}`)
    const information = await lstat(path)
    if (information.isSymbolicLink())
      throw new Error(`Bun runtime curation rejects symlinks: ${path}`)
    const canonical = await realpath(path)
    if (!inside(root, canonical))
      throw new Error(`Bun runtime curation entry resolves outside its root: ${path}`)
    if (information.isDirectory()) output.push(...(await enumerateRegularTree(root, path)))
    else if (information.isFile()) output.push(portable(relative(root, path)))
    else throw new Error(`Bun runtime curation accepts regular files only: ${path}`)
  }
  return output.sort(compareUtf8Bytes)
}

function bunRuntimeBomRef(binding: BunRuntimeLicenseBinding): string {
  return `runtime:bun@${binding.version}#${binding.revision}`
}

function bunRuntimeComponent(curation: ValidatedBunRuntimeCuration): CycloneDxComponent {
  const manifestSha256 = curation.manifestFile.sha256
  return {
    type: "application",
    "bom-ref": bunRuntimeBomRef(curation.binding),
    name: BUN_COMPONENT_NAME,
    version: curation.binding.version,
    licenses: [
      {
        expression: `${BUN_CURATION_LICENSE_REF_PREFIX}${manifestSha256}`,
      },
    ],
    properties: [
      { name: "ralph:classification", value: "embedded-runtime" },
      { name: "ralph:runtime-dependency", value: "true" },
      { name: "ralph:bun-runtime-revision", value: curation.binding.revision },
      { name: "ralph:upstream-repository", value: curation.manifest.sourceRepository },
      { name: "ralph:upstream-commit", value: curation.manifest.sourceRevision },
      { name: "ralph:license-source", value: "validated-local-runtime-curation" },
      { name: "ralph:provenance-source", value: "validated-local-runtime-curation" },
      { name: "ralph:curation-manifest-sha256", value: manifestSha256 },
    ],
  }
}

async function validateBunRuntimeCuration(
  projectRoot: string,
  binding: BunRuntimeLicenseBinding,
): Promise<ValidatedBunRuntimeCuration> {
  const exactBinding: BunRuntimeLicenseBinding = {
    version: binding.version,
    revision: binding.revision,
  }
  if (
    !SEMVER_PATTERN.test(exactBinding.version) ||
    !BUN_REVISION_PATTERN.test(exactBinding.revision)
  ) {
    throw new Error(
      "Standalone Bun license binding requires exact SemVer and lowercase 40-hex revision",
    )
  }
  const source = resolve(
    projectRoot,
    "third_party",
    "bun",
    "runtime",
    exactBinding.version,
    exactBinding.revision,
  )
  const information = await lstat(source).catch(() => undefined)
  if (!information?.isDirectory() || information.isSymbolicLink()) {
    throw new Error(
      `Standalone packaging is blocked: curate the exact Bun runtime license/provenance bundle at ${source}`,
    )
  }
  const sourceRoot = await realpath(source)
  const expectedParent = await realpath(
    resolve(projectRoot, "third_party", "bun", "runtime"),
  ).catch(() => undefined)
  if (!expectedParent || !inside(expectedParent, sourceRoot)) {
    throw new Error(`Bun runtime curation resolves outside third_party/bun/runtime: ${source}`)
  }
  const manifestPath = resolve(sourceRoot, "CURATION.json")
  const manifest = parseBunCurationManifest(
    await readBoundedJson(
      manifestPath,
      "Bun runtime curation manifest",
      MAX_CURATION_MANIFEST_BYTES,
    ),
    exactBinding,
  )
  const actualPaths = await enumerateRegularTree(sourceRoot)
  const declaredPaths = ["CURATION.json", ...manifest.files.map((file) => file.path)].sort(
    compareUtf8Bytes,
  )
  if (JSON.stringify(actualPaths) !== JSON.stringify(declaredPaths)) {
    throw new Error("Bun runtime curation has missing, extra or unmanifested files")
  }

  const files: Array<{
    readonly receipt: BunCurationFile
    readonly inspected: InspectedFile
  }> = []
  for (const entry of manifest.files) {
    const sourcePath = resolve(
      sourceRoot,
      ...assertPortableRelativePath(entry.path, "Bun curation file"),
    )
    const inspected = await inspectBoundedTextFile(sourcePath, entry.kind, MAX_CURATION_FILE_BYTES)
    if (inspected.sizeBytes !== entry.sizeBytes || inspected.sha256 !== entry.sha256) {
      throw new Error(`Bun runtime curation file does not match its receipt: ${entry.path}`)
    }
    files.push({ receipt: entry, inspected })
  }
  const manifestFile = await inspectBoundedTextFile(
    manifestPath,
    "curation-manifest",
    MAX_CURATION_MANIFEST_BYTES,
  )
  return {
    binding: exactBinding,
    sourceRoot,
    manifest,
    manifestFile,
    files,
  }
}

/**
 * Builds the only Bun component accepted in a standalone SBOM. The component
 * is content-bound to a complete local curation that has already passed the
 * same path, receipt, license-text and provenance checks used by packaging.
 */
export async function createValidatedBunRuntimeSbomComponent(
  projectRoot: string,
  binding: BunRuntimeLicenseBinding,
): Promise<CycloneDxComponent> {
  return bunRuntimeComponent(await validateBunRuntimeCuration(projectRoot, binding))
}

async function materializeBunRuntime(
  curation: ValidatedBunRuntimeCuration,
  inventoryRoot: string,
): Promise<LicenseInventoryComponent> {
  const { binding } = curation
  const destinationRoot = resolve(
    inventoryRoot,
    "runtime",
    "bun",
    binding.version,
    binding.revision,
  )
  await mkdir(destinationRoot, { recursive: true })
  const files: MaterializedFile[] = []
  for (const { receipt: entry, inspected } of curation.files) {
    const destination = resolve(destinationRoot, ...entry.path.split("/"))
    await mkdir(dirname(destination), { recursive: true })
    const receipt = await copyRegularVerified(inspected.source, destination, {
      expectedSha256: entry.sha256,
    })
    if (receipt.sizeBytes !== entry.sizeBytes) {
      throw new Error(`Bun runtime curation file changed size: ${entry.path}`)
    }
    files.push({
      path: portable(relative(inventoryRoot, destination)),
      sourceName: entry.path,
      kind: entry.kind,
      sizeBytes: receipt.sizeBytes,
      sha256: receipt.sha256,
    })
  }
  const copiedManifest = await copyRegularVerified(
    curation.manifestFile.source,
    resolve(destinationRoot, "CURATION.json"),
    { expectedSha256: curation.manifestFile.sha256 },
  )
  if (copiedManifest.sizeBytes !== curation.manifestFile.sizeBytes) {
    throw new Error("Bun runtime curation manifest changed size")
  }
  files.push({
    path: portable(relative(inventoryRoot, copiedManifest.destination)),
    sourceName: "CURATION.json",
    kind: "curation-manifest",
    sizeBytes: copiedManifest.sizeBytes,
    sha256: copiedManifest.sha256,
  })
  files.sort((left, right) => compareUtf8Bytes(left.path, right.path))
  const component = bunRuntimeComponent(curation)
  return {
    bomRef: component["bom-ref"],
    name: component.name,
    version: binding.version,
    licenseExpression: licenseExpression(component),
    sourceKind: "bun-runtime",
    sourceRevision: binding.revision,
    files,
  }
}

/**
 * Materializes the license/notices payload from the exact release SBOM. It does
 * not download material and does not infer license text from metadata. Missing
 * package texts, ambiguous Bun-store variants and incomplete runtime curation
 * are release blockers by design.
 */
export async function materializeReleaseLicenseInventory(input: {
  readonly projectRoot: string
  readonly sbom: CycloneDxBom
  readonly sbomSha256: string
  readonly publishedAt: string
  readonly outputDirectory: string
  readonly bunRuntime?: BunRuntimeLicenseBinding
}): Promise<ReleaseLicenseInventoryReceipt> {
  if (!SHA256_PATTERN.test(input.sbomSha256)) {
    throw new Error("License inventory requires the SHA-256 of the actual serialized SBOM")
  }
  const serializedSbomSha256 = createHash("sha256")
    .update(`${JSON.stringify(input.sbom, null, 2)}\n`)
    .digest("hex")
  if (serializedSbomSha256 !== input.sbomSha256) {
    throw new Error("License inventory SBOM hash does not match the exact serialized SBOM object")
  }
  if (
    !Number.isFinite(Date.parse(input.publishedAt)) ||
    new Date(input.publishedAt).toISOString() !== input.publishedAt
  ) {
    throw new Error("License inventory publishedAt must be a canonical ISO-8601 timestamp")
  }
  const projectRoot = await realpath(resolve(input.projectRoot))
  const bunCuration = input.bunRuntime
    ? await validateBunRuntimeCuration(projectRoot, input.bunRuntime)
    : undefined
  const expectedBunRuntime = bunCuration ? bunRuntimeComponent(bunCuration) : undefined
  const npmComponents = npmComponentsFromExactRootGraph(input.sbom, expectedBunRuntime)
  const outputDirectory = resolve(input.outputDirectory)
  const outputParent = dirname(outputDirectory)
  const parentInformation = await lstat(outputParent).catch(() => undefined)
  if (!parentInformation?.isDirectory() || parentInformation.isSymbolicLink()) {
    throw new Error(`License inventory output parent must be a regular directory: ${outputParent}`)
  }
  if (
    await lstat(outputDirectory)
      .then(() => true)
      .catch(() => false)
  ) {
    throw new Error(`License inventory output must not already exist: ${outputDirectory}`)
  }
  await mkdir(outputDirectory, { recursive: false })

  const components: LicenseInventoryComponent[] = []
  let totalBytes = 0
  let totalFiles = 0
  const store = await canonicalBunStore(projectRoot)
  for (const component of npmComponents) {
    const materialized = await materializeNpmComponent(store, component, outputDirectory)
    components.push(materialized)
    totalFiles += materialized.files.length
    totalBytes += materialized.files.reduce((sum, file) => sum + file.sizeBytes, 0)
    if (totalBytes > MAX_LICENSE_INVENTORY_BYTES) {
      throw new Error(`Release license inventory exceeds ${MAX_LICENSE_INVENTORY_BYTES} bytes`)
    }
  }
  const openCode = input.sbom.components.find(
    (component) => component.name === "opencode-curated-source",
  )
  if (!openCode) throw new Error("Release SBOM is missing the curated OpenCode source component")
  const materializedOpenCode = await materializeOpenCode(projectRoot, openCode, outputDirectory)
  components.push(materializedOpenCode)
  totalFiles += materializedOpenCode.files.length
  totalBytes += materializedOpenCode.files.reduce((sum, file) => sum + file.sizeBytes, 0)
  if (totalBytes > MAX_LICENSE_INVENTORY_BYTES) {
    throw new Error(`Release license inventory exceeds ${MAX_LICENSE_INVENTORY_BYTES} bytes`)
  }

  if (bunCuration) {
    const runtime = await materializeBunRuntime(bunCuration, outputDirectory)
    components.push(runtime)
    totalFiles += runtime.files.length
    totalBytes += runtime.files.reduce((sum, file) => sum + file.sizeBytes, 0)
  }
  const maximumBytes =
    MAX_LICENSE_INVENTORY_BYTES +
    (input.bunRuntime ? MAX_CURATION_BYTES + MAX_CURATION_MANIFEST_BYTES : 0)
  if (totalBytes > maximumBytes) {
    throw new Error("Combined release license inventory exceeds its bounded maximum")
  }
  components.sort((left, right) => compareUtf8Bytes(left.bomRef, right.bomRef))
  const manifest = {
    schemaVersion: 1,
    publishedAt: input.publishedAt,
    sbomSha256: input.sbomSha256,
    components,
  } as const
  const manifestPath = resolve(outputDirectory, "manifest.json")
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  })
  await chmod(manifestPath, 0o644)
  const manifestSha256 = await sha256File(manifestPath)
  return {
    rootDirectory: outputDirectory,
    manifestPath,
    manifestSha256,
    totalFiles,
    totalBytes,
  }
}
