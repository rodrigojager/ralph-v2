import { createHash } from "node:crypto"
import { lstat, readdir, readFile, realpath } from "node:fs/promises"
import { extname, isAbsolute, relative, resolve } from "node:path"

const MANIFEST_RELATIVE_PATH = "third_party/opencode/PROVENANCE.json"
const MAX_MANIFEST_BYTES = 512 * 1024
const MAX_DOCUMENT_BYTES = 512 * 1024
const MAX_DESTINATION_BYTES = 2 * 1024 * 1024
const MAX_SCAN_FILES = 16_384
const SHA256 = /^[0-9a-f]{64}$/u
const SHA1 = /^[0-9a-f]{40}$/u
const PATCH_ID = /^P[0-9]{4}$/u
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u
const THIRD_PARTY_FILES = [
  "LICENSE",
  "PROVENANCE.json",
  "UPSTREAM.md",
  "copied-files.md",
  "patches.md",
] as const
const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const
const ASSET_EXTENSIONS = new Set([
  ".gif",
  ".ico",
  ".icns",
  ".jpeg",
  ".jpg",
  ".otf",
  ".png",
  ".svg",
  ".ttf",
  ".webp",
  ".woff",
  ".woff2",
])

export type OpenCodeSourceClassification = "copied" | "derived" | "reference-only"
export type OpenCodeDestinationClassification = "copied" | "derived"

export interface OpenCodeUpstream {
  readonly repository: string
  readonly revision: string
  readonly packageVersion: string
  readonly licenseExpression: string
  readonly licensePath: string
  readonly licenseSha256Lf: string
  readonly snapshotVerifiedDate: string
}

export interface OpenCodeSourceRecord {
  readonly path: string
  readonly classification: OpenCodeSourceClassification
  readonly gitBlobSha1: string
  readonly sha256AuditedCheckout: string
  readonly sha256Lf: string
  readonly patchIds: readonly string[]
  readonly destinationPaths: readonly string[]
}

export interface OpenCodeDestinationRecord {
  readonly path: string
  readonly classification: OpenCodeDestinationClassification
  readonly sourcePaths: readonly string[]
  readonly patchIds: readonly string[]
  readonly sha256: string
  readonly sha256Lf: string
}

export interface OpenCodePatchRecord {
  readonly id: string
  readonly sourcePaths: readonly string[]
  readonly destinationPaths: readonly string[]
}

export interface OpenCodeBrandingOccurrence {
  readonly path: string
  readonly token: string
  readonly exactCount: number
  readonly classification: "attribution-disclaimer" | "protocol-required"
  readonly patchIds: readonly string[]
  readonly reason: string
}

export interface OpenCodeAllowedAsset {
  readonly path: string
  readonly sha256: string
  readonly reason: string
}

export interface OpenCodeBrandingPolicy {
  readonly productIdentityCopied: false
  readonly scanRoots: readonly string[]
  readonly excludedDirectoryNames: readonly string[]
  readonly forbiddenTokens: readonly string[]
  readonly allowedOccurrences: readonly OpenCodeBrandingOccurrence[]
  readonly allowedAssets: readonly OpenCodeAllowedAsset[]
}

export interface OpenCodeProvenanceManifest {
  readonly schemaVersion: 1
  readonly upstream: OpenCodeUpstream
  readonly sources: readonly OpenCodeSourceRecord[]
  readonly destinations: readonly OpenCodeDestinationRecord[]
  readonly patches: readonly OpenCodePatchRecord[]
  readonly brandingPolicy: OpenCodeBrandingPolicy
}

export interface VerifiedOpenCodeProvenance {
  readonly manifest: OpenCodeProvenanceManifest
  readonly manifestSha256: string
}

export interface OpenCodeSbomComponent {
  readonly type: "library"
  readonly "bom-ref": string
  readonly name: "opencode-curated-source"
  readonly version: string
  readonly purl: string
  readonly licenses: readonly [{ readonly expression: string }]
  readonly properties: readonly { readonly name: string; readonly value: string }[]
}

function fail(label: string, message: string): never {
  throw new Error(`OpenCode provenance ${label}: ${message}`)
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex")
}

function normalizeLf(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return fail(label, "must be valid UTF-8")
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail(label, "must be an object")
  }
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort(compareUtf8)
  const wanted = [...expected].sort(compareUtf8)
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(label, `keys must be exactly ${wanted.join(", ")}`)
  }
}

function boundedString(value: unknown, label: string, maximum = 512, allowSpace = true): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 0x1f || code === 0x7f
    }) ||
    (!allowSpace && /\s/u.test(value))
  ) {
    return fail(label, `must be a bounded${allowSpace ? "" : " space-free"} string`)
  }
  return value
}

function digest(value: unknown, expression: RegExp, label: string): string {
  const parsed = boundedString(value, label, 128, false)
  if (!expression.test(parsed)) fail(label, "has an invalid digest")
  return parsed
}

function safeRelativePath(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 512, false)
  const segments = parsed.split("/")
  if (
    parsed.includes("\\") ||
    parsed.includes(":") ||
    isAbsolute(parsed) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return fail(label, "must be a normalized forward-slash relative path")
  }
  return parsed
}

function boundedArray(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    return fail(label, `must be an array with at most ${maximum} entries`)
  }
  return value
}

function uniqueSortedStrings(
  value: unknown,
  label: string,
  maximum: number,
  parser: (entry: unknown, entryLabel: string) => string = boundedString,
): readonly string[] {
  const entries = boundedArray(value, label, maximum).map((entry, index) =>
    parser(entry, `${label}[${index}]`),
  )
  const sorted = [...entries].sort(compareUtf8)
  if (
    new Set(entries).size !== entries.length ||
    JSON.stringify(entries) !== JSON.stringify(sorted)
  ) {
    fail(label, "must contain unique entries in UTF-8 byte order")
  }
  return entries
}

function patchIds(value: unknown, label: string): readonly string[] {
  return uniqueSortedStrings(value, label, 32, (entry, entryLabel) => {
    const parsed = boundedString(entry, entryLabel, 5, false)
    if (!PATCH_ID.test(parsed)) fail(entryLabel, "must use Pdddd format")
    return parsed
  })
}

function parseUpstream(value: unknown): OpenCodeUpstream {
  const record = asRecord(value, "manifest.upstream")
  exactKeys(
    record,
    [
      "repository",
      "revision",
      "packageVersion",
      "licenseExpression",
      "licensePath",
      "licenseSha256Lf",
      "snapshotVerifiedDate",
    ],
    "manifest.upstream",
  )
  const repository = boundedString(record.repository, "manifest.upstream.repository", 256, false)
  if (repository !== "https://github.com/anomalyco/opencode") {
    fail("manifest.upstream.repository", "must identify the audited repository")
  }
  const packageVersion = boundedString(
    record.packageVersion,
    "manifest.upstream.packageVersion",
    64,
    false,
  )
  if (!VERSION.test(packageVersion)) {
    fail("manifest.upstream.packageVersion", "must be a concrete version")
  }
  const licenseExpression = boundedString(
    record.licenseExpression,
    "manifest.upstream.licenseExpression",
    64,
    false,
  )
  if (licenseExpression !== "MIT") {
    fail("manifest.upstream.licenseExpression", "must match the audited MIT license")
  }
  const snapshotVerifiedDate = boundedString(
    record.snapshotVerifiedDate,
    "manifest.upstream.snapshotVerifiedDate",
    10,
    false,
  )
  if (!DATE.test(snapshotVerifiedDate)) {
    fail("manifest.upstream.snapshotVerifiedDate", "must use YYYY-MM-DD")
  }
  return {
    repository,
    revision: digest(record.revision, SHA1, "manifest.upstream.revision"),
    packageVersion,
    licenseExpression,
    licensePath: safeRelativePath(record.licensePath, "manifest.upstream.licensePath"),
    licenseSha256Lf: digest(record.licenseSha256Lf, SHA256, "manifest.upstream.licenseSha256Lf"),
    snapshotVerifiedDate,
  }
}

function parseSource(value: unknown, index: number): OpenCodeSourceRecord {
  const label = `manifest.sources[${index}]`
  const record = asRecord(value, label)
  exactKeys(
    record,
    [
      "path",
      "classification",
      "gitBlobSha1",
      "sha256AuditedCheckout",
      "sha256Lf",
      "patchIds",
      "destinationPaths",
    ],
    label,
  )
  const classification = boundedString(record.classification, `${label}.classification`, 32, false)
  if (
    !(["copied", "derived", "reference-only"] as const).includes(
      classification as OpenCodeSourceClassification,
    )
  ) {
    fail(`${label}.classification`, "must be copied, derived or reference-only")
  }
  const parsedPatchIds = patchIds(record.patchIds, `${label}.patchIds`)
  const destinationPaths = uniqueSortedStrings(
    record.destinationPaths,
    `${label}.destinationPaths`,
    128,
    safeRelativePath,
  )
  if (classification === "reference-only") {
    if (parsedPatchIds.length !== 0 || destinationPaths.length !== 0) {
      fail(label, "reference-only sources cannot claim patches or destinations")
    }
  } else if (parsedPatchIds.length === 0 || destinationPaths.length === 0) {
    fail(label, "copied and derived sources require patches and destinations")
  }
  return {
    path: safeRelativePath(record.path, `${label}.path`),
    classification: classification as OpenCodeSourceClassification,
    gitBlobSha1: digest(record.gitBlobSha1, SHA1, `${label}.gitBlobSha1`),
    sha256AuditedCheckout: digest(
      record.sha256AuditedCheckout,
      SHA256,
      `${label}.sha256AuditedCheckout`,
    ),
    sha256Lf: digest(record.sha256Lf, SHA256, `${label}.sha256Lf`),
    patchIds: parsedPatchIds,
    destinationPaths,
  }
}

function parseDestination(value: unknown, index: number): OpenCodeDestinationRecord {
  const label = `manifest.destinations[${index}]`
  const record = asRecord(value, label)
  exactKeys(
    record,
    ["path", "classification", "sourcePaths", "patchIds", "sha256", "sha256Lf"],
    label,
  )
  const classification = boundedString(record.classification, `${label}.classification`, 16, false)
  if (classification !== "copied" && classification !== "derived") {
    fail(`${label}.classification`, "must be copied or derived")
  }
  const sourcePaths = uniqueSortedStrings(
    record.sourcePaths,
    `${label}.sourcePaths`,
    128,
    safeRelativePath,
  )
  const parsedPatchIds = patchIds(record.patchIds, `${label}.patchIds`)
  if (sourcePaths.length === 0 || parsedPatchIds.length === 0) {
    fail(label, "destinations require at least one source and patch")
  }
  return {
    path: safeRelativePath(record.path, `${label}.path`),
    classification,
    sourcePaths,
    patchIds: parsedPatchIds,
    sha256: digest(record.sha256, SHA256, `${label}.sha256`),
    sha256Lf: digest(record.sha256Lf, SHA256, `${label}.sha256Lf`),
  }
}

function parsePatch(value: unknown, index: number): OpenCodePatchRecord {
  const label = `manifest.patches[${index}]`
  const record = asRecord(value, label)
  exactKeys(record, ["id", "sourcePaths", "destinationPaths"], label)
  const ids = patchIds([record.id], `${label}.id`)
  return {
    id: ids[0] as string,
    sourcePaths: uniqueSortedStrings(
      record.sourcePaths,
      `${label}.sourcePaths`,
      128,
      safeRelativePath,
    ),
    destinationPaths: uniqueSortedStrings(
      record.destinationPaths,
      `${label}.destinationPaths`,
      256,
      safeRelativePath,
    ),
  }
}

function parseBrandingOccurrence(value: unknown, index: number): OpenCodeBrandingOccurrence {
  const label = `manifest.brandingPolicy.allowedOccurrences[${index}]`
  const record = asRecord(value, label)
  exactKeys(record, ["path", "token", "exactCount", "classification", "patchIds", "reason"], label)
  const classification = boundedString(record.classification, `${label}.classification`, 64, false)
  if (classification !== "attribution-disclaimer" && classification !== "protocol-required") {
    fail(`${label}.classification`, "must be attribution-disclaimer or protocol-required")
  }
  if (!Number.isSafeInteger(record.exactCount) || (record.exactCount as number) < 1) {
    fail(`${label}.exactCount`, "must be a positive safe integer")
  }
  return {
    path: safeRelativePath(record.path, `${label}.path`),
    token: boundedString(record.token, `${label}.token`, 128, false).toLowerCase(),
    exactCount: record.exactCount as number,
    classification,
    patchIds: patchIds(record.patchIds, `${label}.patchIds`),
    reason: boundedString(record.reason, `${label}.reason`, 512),
  }
}

function parseAllowedAsset(value: unknown, index: number): OpenCodeAllowedAsset {
  const label = `manifest.brandingPolicy.allowedAssets[${index}]`
  const record = asRecord(value, label)
  exactKeys(record, ["path", "sha256", "reason"], label)
  return {
    path: safeRelativePath(record.path, `${label}.path`),
    sha256: digest(record.sha256, SHA256, `${label}.sha256`),
    reason: boundedString(record.reason, `${label}.reason`, 512),
  }
}

function parseBrandingPolicy(value: unknown): OpenCodeBrandingPolicy {
  const label = "manifest.brandingPolicy"
  const record = asRecord(value, label)
  exactKeys(
    record,
    [
      "productIdentityCopied",
      "scanRoots",
      "excludedDirectoryNames",
      "forbiddenTokens",
      "allowedOccurrences",
      "allowedAssets",
    ],
    label,
  )
  if (record.productIdentityCopied !== false) {
    fail(`${label}.productIdentityCopied`, "must remain false")
  }
  const scanRoots = uniqueSortedStrings(
    record.scanRoots,
    `${label}.scanRoots`,
    16,
    safeRelativePath,
  )
  const excludedDirectoryNames = uniqueSortedStrings(
    record.excludedDirectoryNames,
    `${label}.excludedDirectoryNames`,
    32,
    (entry, entryLabel) => {
      const parsed = boundedString(entry, entryLabel, 64, false)
      if (parsed.includes("/") || parsed.includes("\\")) {
        fail(entryLabel, "must be one directory name")
      }
      return parsed
    },
  )
  const forbiddenTokens = uniqueSortedStrings(
    record.forbiddenTokens,
    `${label}.forbiddenTokens`,
    32,
    (entry, entryLabel) => boundedString(entry, entryLabel, 128, false).toLowerCase(),
  )
  if (forbiddenTokens.length === 0) fail(`${label}.forbiddenTokens`, "cannot be empty")
  if (!sameStrings(scanRoots, ["apps", "packages"])) {
    fail(`${label}.scanRoots`, "must cover both production application and package trees")
  }
  if (!sameStrings(excludedDirectoryNames, ["fixtures", "node_modules", "test", "tests"])) {
    fail(`${label}.excludedDirectoryNames`, "may exclude only non-production test/dependency trees")
  }
  if (!sameStrings(forbiddenTokens, ["@opencode-ai", "anomalyco", "opencode"])) {
    fail(`${label}.forbiddenTokens`, "must retain the complete OpenCode identity token set")
  }
  const allowedOccurrences = boundedArray(
    record.allowedOccurrences,
    `${label}.allowedOccurrences`,
    64,
  ).map(parseBrandingOccurrence)
  const occurrenceKeys = allowedOccurrences.map((entry) => `${entry.path}\u0000${entry.token}`)
  if (
    new Set(occurrenceKeys).size !== occurrenceKeys.length ||
    JSON.stringify(occurrenceKeys) !== JSON.stringify([...occurrenceKeys].sort(compareUtf8))
  ) {
    fail(`${label}.allowedOccurrences`, "must be unique and sorted by path/token")
  }
  const allowedAssets = boundedArray(record.allowedAssets, `${label}.allowedAssets`, 64).map(
    parseAllowedAsset,
  )
  const assetPaths = allowedAssets.map((entry) => entry.path)
  if (
    new Set(assetPaths).size !== assetPaths.length ||
    JSON.stringify(assetPaths) !== JSON.stringify([...assetPaths].sort(compareUtf8))
  ) {
    fail(`${label}.allowedAssets`, "must be unique and sorted by path")
  }
  return {
    productIdentityCopied: false,
    scanRoots,
    excludedDirectoryNames,
    forbiddenTokens,
    allowedOccurrences,
    allowedAssets,
  }
}

export function parseOpenCodeProvenanceManifest(value: unknown): OpenCodeProvenanceManifest {
  const record = asRecord(value, "manifest")
  exactKeys(
    record,
    ["schemaVersion", "upstream", "sources", "destinations", "patches", "brandingPolicy"],
    "manifest",
  )
  if (record.schemaVersion !== 1) fail("manifest.schemaVersion", "must be 1")
  const sources = boundedArray(record.sources, "manifest.sources", 128).map(parseSource)
  const destinations = boundedArray(record.destinations, "manifest.destinations", 512).map(
    parseDestination,
  )
  const patches = boundedArray(record.patches, "manifest.patches", 128).map(parsePatch)
  const assertUniqueSorted = <T>(
    entries: readonly T[],
    label: string,
    key: "path" | "id",
    select: (entry: T) => string,
  ): void => {
    const values = entries.map(select)
    if (
      new Set(values).size !== values.length ||
      JSON.stringify(values) !== JSON.stringify([...values].sort(compareUtf8))
    ) {
      fail(label, `must be unique and sorted by ${key}`)
    }
  }
  assertUniqueSorted(sources, "manifest.sources", "path", (source) => source.path)
  assertUniqueSorted(
    destinations,
    "manifest.destinations",
    "path",
    (destination) => destination.path,
  )
  assertUniqueSorted(patches, "manifest.patches", "id", (patch) => patch.id)
  const manifest: OpenCodeProvenanceManifest = {
    schemaVersion: 1,
    upstream: parseUpstream(record.upstream),
    sources,
    destinations,
    patches,
    brandingPolicy: parseBrandingPolicy(record.brandingPolicy),
  }
  validateInventoryGraph(manifest)
  return manifest
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function validateInventoryGraph(manifest: OpenCodeProvenanceManifest): void {
  const sourceByPath = new Map(manifest.sources.map((source) => [source.path, source]))
  const destinationByPath = new Map(
    manifest.destinations.map((destination) => [destination.path, destination]),
  )
  const patchById = new Map(manifest.patches.map((patch) => [patch.id, patch]))

  for (const source of manifest.sources) {
    for (const patchId of source.patchIds) {
      if (!patchById.has(patchId))
        fail(`source ${source.path}`, `references unknown patch ${patchId}`)
    }
    for (const destinationPath of source.destinationPaths) {
      const destination = destinationByPath.get(destinationPath)
      if (!destination?.sourcePaths.includes(source.path)) {
        fail(`source ${source.path}`, `has an asymmetric destination ${destinationPath}`)
      }
      if (source.classification !== destination.classification) {
        fail(`source ${source.path}`, `classification differs from ${destinationPath}`)
      }
      if (!source.patchIds.some((patchId) => destination.patchIds.includes(patchId))) {
        fail(`source ${source.path}`, `shares no patch with ${destinationPath}`)
      }
    }
  }

  for (const destination of manifest.destinations) {
    for (const sourcePath of destination.sourcePaths) {
      const source = sourceByPath.get(sourcePath)
      if (!source?.destinationPaths.includes(destination.path)) {
        fail(`destination ${destination.path}`, `has an asymmetric source ${sourcePath}`)
      }
    }
    for (const patchId of destination.patchIds) {
      if (!patchById.has(patchId)) {
        fail(`destination ${destination.path}`, `references unknown patch ${patchId}`)
      }
    }
  }

  for (const patch of manifest.patches) {
    const sources = manifest.sources
      .filter((source) => source.patchIds.includes(patch.id))
      .map((source) => source.path)
      .sort(compareUtf8)
    const destinations = manifest.destinations
      .filter((destination) => destination.patchIds.includes(patch.id))
      .map((destination) => destination.path)
      .sort(compareUtf8)
    if (
      !sameStrings(sources, patch.sourcePaths) ||
      !sameStrings(destinations, patch.destinationPaths)
    ) {
      fail(`patch ${patch.id}`, "does not exactly equal its source/destination edges")
    }
  }

  for (const occurrence of manifest.brandingPolicy.allowedOccurrences) {
    for (const patchId of occurrence.patchIds) {
      if (!patchById.has(patchId)) {
        fail(`branding occurrence ${occurrence.path}`, `references unknown patch ${patchId}`)
      }
    }
    if (occurrence.classification === "protocol-required") {
      const destination = destinationByPath.get(occurrence.path)
      if (
        occurrence.patchIds.length === 0 ||
        !destination ||
        !occurrence.patchIds.every((patchId) => destination.patchIds.includes(patchId))
      ) {
        fail(
          `branding occurrence ${occurrence.path}`,
          "protocol exceptions must bind a derived destination and its patch",
        )
      }
    }
  }

  const licenseSource = sourceByPath.get("LICENSE")
  const licenseDestination = destinationByPath.get(manifest.upstream.licensePath)
  if (
    licenseSource?.classification !== "copied" ||
    licenseSource.sha256Lf !== manifest.upstream.licenseSha256Lf ||
    licenseDestination?.classification !== "copied" ||
    licenseDestination.sha256Lf !== manifest.upstream.licenseSha256Lf
  ) {
    fail("license", "source, destination and upstream LF hashes must be identical")
  }
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

async function boundedRegularFile(
  projectRoot: string,
  relativePath: string,
  maximum: number,
  label: string,
): Promise<{ readonly bytes: Uint8Array; readonly realPath: string }> {
  const requested = resolve(projectRoot, relativePath)
  if (!inside(projectRoot, requested)) fail(label, "resolved outside the project")
  const information = await lstat(requested).catch(() => undefined)
  if (
    !information?.isFile() ||
    information.isSymbolicLink() ||
    information.size <= 0 ||
    information.size > maximum
  ) {
    fail(label, `must be a bounded non-empty regular file: ${relativePath}`)
  }
  const canonical = await realpath(requested)
  if (!inside(projectRoot, canonical)) fail(label, "canonical path escaped the project")
  const bytes = await readFile(canonical)
  if (bytes.byteLength !== information.size) fail(label, "changed while being read")
  const after = await lstat(canonical)
  if (!after.isFile() || after.isSymbolicLink() || after.size !== information.size) {
    fail(label, "identity changed while being read")
  }
  return { bytes, realPath: canonical }
}

function oneMatch(source: string, expression: RegExp, label: string): string {
  const matches = [...source.matchAll(expression)]
  if (matches.length !== 1 || !matches[0]?.[1]) fail(label, "must occur exactly once")
  return matches[0][1]
}

function parseUpstreamDocument(
  source: string,
  manifest: OpenCodeProvenanceManifest,
  manifestSha256: string,
): void {
  const normalized = normalizeLf(source)
  const repository = oneMatch(normalized, /^- Repository: <([^>]+)>$/gmu, "UPSTREAM repository")
  const revision = oneMatch(normalized, /^- Commit: `([^`]+)`$/gmu, "UPSTREAM commit")
  const version = oneMatch(
    normalized,
    /^- Upstream package version at this commit: `([^`]+)`$/gmu,
    "UPSTREAM version",
  )
  const license = oneMatch(normalized, /^- License: ([^\r\n]+)$/gmu, "UPSTREAM license")
  const verifiedDate = oneMatch(
    normalized,
    /^- Snapshot verified: ([0-9]{4}-[0-9]{2}-[0-9]{2})$/gmu,
    "UPSTREAM verification date",
  )
  const structuredHash = oneMatch(
    normalized,
    /^- Structured provenance SHA-256: `([0-9a-f]{64})`$/gmu,
    "UPSTREAM manifest hash",
  )
  if (
    repository !== manifest.upstream.repository ||
    revision !== manifest.upstream.revision ||
    version !== manifest.upstream.packageVersion ||
    license !== manifest.upstream.licenseExpression ||
    verifiedDate !== manifest.upstream.snapshotVerifiedDate ||
    structuredHash !== manifestSha256
  ) {
    fail("UPSTREAM", "repository, revision, version, license or manifest hash diverged")
  }

  const rowExpression =
    /^\| `([^`]+)` \| `([0-9a-f]{40})` \| `([0-9a-f]{64})` \| `([0-9a-f]{64})` \|$/gmu
  const rows = [...normalized.matchAll(rowExpression)].map((match) => ({
    path: match[1] as string,
    blob: match[2] as string,
    checkout: match[3] as string,
    lf: match[4] as string,
  }))
  if (
    rows.length !== manifest.sources.length ||
    new Set(rows.map((row) => row.path)).size !== rows.length
  ) {
    fail("UPSTREAM source table", "must list every structured source exactly once")
  }
  for (const sourceRecord of manifest.sources) {
    const row = rows.find((candidate) => candidate.path === sourceRecord.path)
    if (
      !row ||
      row.blob !== sourceRecord.gitBlobSha1 ||
      row.checkout !== sourceRecord.sha256AuditedCheckout ||
      row.lf !== sourceRecord.sha256Lf
    ) {
      fail("UPSTREAM source table", `does not match ${sourceRecord.path}`)
    }
  }
}

function parseHumanMaps(
  copiedFiles: string,
  patches: string,
  manifest: OpenCodeProvenanceManifest,
): void {
  const sourceRows = [
    ...normalizeLf(copiedFiles).matchAll(/^\| (copied|derived|reference-only) \| `([^`]+)` \|/gmu),
  ].map((match) => ({ classification: match[1], path: match[2] }))
  if (
    sourceRows.length !== manifest.sources.length ||
    new Set(sourceRows.map((row) => row.path)).size !== sourceRows.length
  ) {
    fail("copied-files.md", "must contain the exact structured source inventory")
  }
  for (const source of manifest.sources) {
    const row = sourceRows.find((candidate) => candidate.path === source.path)
    if (!row || row.classification !== source.classification) {
      fail("copied-files.md", `classification diverged for ${source.path}`)
    }
  }
  for (const destination of manifest.destinations) {
    if (!copiedFiles.includes(`\`${destination.path}\``)) {
      fail("copied-files.md", `does not explain destination ${destination.path}`)
    }
  }

  const documentedPatchIds = [...normalizeLf(patches).matchAll(/^#{2,3} (P[0-9]{4}) —/gmu)].map(
    (match) => match[1] as string,
  )
  const expectedPatchIds = manifest.patches.map((patch) => patch.id)
  if (!sameStrings(documentedPatchIds, expectedPatchIds)) {
    fail("patches.md", "must document exactly the structured patch IDs in order")
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}

async function scanBranding(projectRoot: string, policy: OpenCodeBrandingPolicy): Promise<void> {
  const forbidden = [...policy.forbiddenTokens].sort((left, right) => right.length - left.length)
  const tokenExpression = new RegExp(forbidden.map(escapeRegex).join("|"), "giu")
  const actualOccurrences = new Map<string, number>()
  const actualAssets = new Map<string, string>()
  let visited = 0

  const visit = async (relativeDirectory: string): Promise<void> => {
    const absoluteDirectory = resolve(projectRoot, relativeDirectory)
    if (!inside(projectRoot, absoluteDirectory)) fail("branding scan", "directory escaped project")
    const information = await lstat(absoluteDirectory).catch(() => undefined)
    if (!information?.isDirectory() || information.isSymbolicLink()) {
      fail("branding scan", `requires regular directory ${relativeDirectory}`)
    }
    const entries = (await readdir(absoluteDirectory, { withFileTypes: true })).sort(
      (left, right) => compareUtf8(left.name, right.name),
    )
    for (const entry of entries) {
      if (entry.isDirectory() && policy.excludedDirectoryNames.includes(entry.name)) continue
      const child = `${relativeDirectory}/${entry.name}`
      if (entry.isSymbolicLink()) fail("branding scan", `rejects symbolic link ${child}`)
      if (entry.isDirectory()) {
        await visit(child)
        continue
      }
      if (!entry.isFile()) fail("branding scan", `rejects non-regular entry ${child}`)
      visited += 1
      if (visited > MAX_SCAN_FILES) fail("branding scan", "exceeded the bounded file count")
      const file = await boundedRegularFile(
        projectRoot,
        child,
        MAX_DESTINATION_BYTES,
        `branding scan ${child}`,
      )
      const extension = extname(entry.name).toLowerCase()
      const pathToken = tokenExpression.test(child)
      tokenExpression.lastIndex = 0
      if (ASSET_EXTENSIONS.has(extension) && pathToken) {
        actualAssets.set(child, sha256(file.bytes))
      }
      let text: string
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)
      } catch {
        continue
      }
      for (const match of text.matchAll(tokenExpression)) {
        const token = match[0].toLowerCase()
        const key = `${child}\u0000${token}`
        actualOccurrences.set(key, (actualOccurrences.get(key) ?? 0) + 1)
      }
    }
  }

  for (const root of policy.scanRoots) await visit(root)

  const allowedOccurrences = new Map(
    policy.allowedOccurrences.map((entry) => [`${entry.path}\u0000${entry.token}`, entry]),
  )
  for (const [key, count] of actualOccurrences) {
    const allowed = allowedOccurrences.get(key)
    if (!allowed || allowed.exactCount !== count) {
      fail(
        "branding scan",
        `undeclared or mismatched product token at ${key.replace("\u0000", "#")}`,
      )
    }
  }
  for (const [key, allowed] of allowedOccurrences) {
    if (actualOccurrences.get(key) !== allowed.exactCount) {
      fail(
        "branding scan",
        `declared occurrence is absent or changed: ${allowed.path}#${allowed.token}`,
      )
    }
  }

  const allowedAssets = new Map(policy.allowedAssets.map((entry) => [entry.path, entry]))
  for (const [path, hash] of actualAssets) {
    if (allowedAssets.get(path)?.sha256 !== hash) {
      fail("branding scan", `undeclared OpenCode-named asset ${path}`)
    }
  }
  for (const [path, allowed] of allowedAssets) {
    if (actualAssets.get(path) !== allowed.sha256) {
      fail("branding scan", `declared asset is absent or changed: ${path}`)
    }
  }
}

async function verifyDependencyBoundary(projectRoot: string): Promise<void> {
  const manifestPaths = ["package.json"]
  for (const parent of ["apps", "packages"] as const) {
    const entries = await readdir(resolve(projectRoot, parent), { withFileTypes: true })
    for (const entry of entries.sort((left, right) => compareUtf8(left.name, right.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const path = `${parent}/${entry.name}/package.json`
      const information = await lstat(resolve(projectRoot, path)).catch(() => undefined)
      if (information?.isFile() && !information.isSymbolicLink()) manifestPaths.push(path)
    }
  }
  for (const path of manifestPaths) {
    const file = await boundedRegularFile(projectRoot, path, MAX_DOCUMENT_BYTES, `manifest ${path}`)
    let value: unknown
    try {
      value = JSON.parse(decodeUtf8(file.bytes, `manifest ${path}`))
    } catch (error) {
      fail(`manifest ${path}`, error instanceof Error ? error.message : "invalid JSON")
    }
    const record = asRecord(value, `manifest ${path}`)
    for (const sectionName of DEPENDENCY_SECTIONS) {
      const section = record[sectionName]
      if (section === undefined) continue
      const dependencies = asRecord(section, `manifest ${path}.${sectionName}`)
      for (const [name, source] of Object.entries(dependencies)) {
        const lowerName = name.toLowerCase()
        const lowerSource = String(source).toLowerCase()
        if (
          lowerName === "opencode" ||
          lowerName.startsWith("@opencode-ai/") ||
          lowerSource.includes("anomalyco/opencode") ||
          lowerSource.includes("ralph-v2-opencode-")
        ) {
          fail(`manifest ${path}`, `contains undeclared OpenCode dependency ${name}`)
        }
      }
    }
  }
}

function canonicalJson(value: unknown): string {
  const serialize = (entry: unknown): string => {
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") {
      return JSON.stringify(entry)
    }
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) fail("canonical JSON", "rejects non-finite numbers")
      return JSON.stringify(entry)
    }
    if (Array.isArray(entry)) return `[${entry.map(serialize).join(",")}]`
    if (entry && typeof entry === "object") {
      const fields = Object.entries(entry as Record<string, unknown>)
        .filter(([, field]) => field !== undefined)
        .sort(([left], [right]) => compareUtf8(left, right))
      return `{${fields.map(([key, field]) => `${JSON.stringify(key)}:${serialize(field)}`).join(",")}}`
    }
    return fail("canonical JSON", `rejects ${typeof entry}`)
  }
  return serialize(value)
}

export function createOpenCodeSbomComponent(
  provenance: VerifiedOpenCodeProvenance,
): OpenCodeSbomComponent {
  const { upstream } = provenance.manifest
  const reference = `pkg:github/anomalyco/opencode@${upstream.revision}`
  return {
    type: "library",
    "bom-ref": reference,
    name: "opencode-curated-source",
    version: `${upstream.packageVersion}+${upstream.revision.slice(0, 7)}`,
    purl: reference,
    licenses: [{ expression: upstream.licenseExpression }],
    properties: [
      { name: "ralph:classification", value: "bounded-derived-source" },
      { name: "ralph:provenance-manifest-sha256", value: provenance.manifestSha256 },
      { name: "ralph:runtime-dependency", value: "false" },
      { name: "ralph:upstream-commit", value: upstream.revision },
      { name: "ralph:upstream-license", value: upstream.licenseExpression },
      { name: "ralph:upstream-license-sha256-lf", value: upstream.licenseSha256Lf },
      { name: "ralph:upstream-repository", value: upstream.repository },
      { name: "ralph:upstream-version", value: upstream.packageVersion },
    ],
  }
}

export function assertOpenCodeSbomComponent(
  component: unknown,
  provenance: VerifiedOpenCodeProvenance,
): asserts component is OpenCodeSbomComponent {
  if (canonicalJson(component) !== canonicalJson(createOpenCodeSbomComponent(provenance))) {
    fail(
      "SBOM component",
      "must exactly bind repository, revision, license, license hash and manifest hash",
    )
  }
}

export async function verifyOpenCodeProvenance(
  projectRootInput: string,
): Promise<VerifiedOpenCodeProvenance> {
  const projectRoot = await realpath(resolve(projectRootInput))
  const manifestFile = await boundedRegularFile(
    projectRoot,
    MANIFEST_RELATIVE_PATH,
    MAX_MANIFEST_BYTES,
    "manifest file",
  )
  const manifestText = decodeUtf8(manifestFile.bytes, "manifest file")
  let parsed: unknown
  try {
    parsed = JSON.parse(manifestText)
  } catch (error) {
    fail("manifest file", error instanceof Error ? error.message : "invalid JSON")
  }
  const manifest = parseOpenCodeProvenanceManifest(parsed)
  const manifestSha256 = sha256(manifestFile.bytes)

  const thirdPartyRoot = resolve(projectRoot, "third_party/opencode")
  const thirdPartyEntries = (await readdir(thirdPartyRoot, { withFileTypes: true })).sort(
    (left, right) => compareUtf8(left.name, right.name),
  )
  if (
    !sameStrings(
      thirdPartyEntries.map((entry) => entry.name),
      THIRD_PARTY_FILES,
    ) ||
    thirdPartyEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
  ) {
    fail("third_party/opencode", "contains a missing, extra or non-regular file")
  }

  const [upstream, copiedFiles, patches, notices] = await Promise.all([
    boundedRegularFile(
      projectRoot,
      "third_party/opencode/UPSTREAM.md",
      MAX_DOCUMENT_BYTES,
      "UPSTREAM.md",
    ),
    boundedRegularFile(
      projectRoot,
      "third_party/opencode/copied-files.md",
      MAX_DOCUMENT_BYTES,
      "copied-files.md",
    ),
    boundedRegularFile(
      projectRoot,
      "third_party/opencode/patches.md",
      MAX_DOCUMENT_BYTES,
      "patches.md",
    ),
    boundedRegularFile(
      projectRoot,
      "THIRD_PARTY_NOTICES.md",
      MAX_DOCUMENT_BYTES,
      "THIRD_PARTY_NOTICES.md",
    ),
  ])
  parseUpstreamDocument(decodeUtf8(upstream.bytes, "UPSTREAM.md"), manifest, manifestSha256)
  parseHumanMaps(
    decodeUtf8(copiedFiles.bytes, "copied-files.md"),
    decodeUtf8(patches.bytes, "patches.md"),
    manifest,
  )
  const noticeText = decodeUtf8(notices.bytes, "THIRD_PARTY_NOTICES.md")
  for (const required of [
    manifest.upstream.repository,
    manifest.upstream.revision,
    `License: ${manifest.upstream.licenseExpression}`,
    MANIFEST_RELATIVE_PATH,
  ]) {
    if (!noticeText.includes(required)) fail("THIRD_PARTY_NOTICES.md", `is missing ${required}`)
  }

  for (const destination of manifest.destinations) {
    const file = await boundedRegularFile(
      projectRoot,
      destination.path,
      MAX_DESTINATION_BYTES,
      `destination ${destination.path}`,
    )
    const text = decodeUtf8(file.bytes, `destination ${destination.path}`)
    if (
      sha256(file.bytes) !== destination.sha256 ||
      sha256(normalizeLf(text)) !== destination.sha256Lf
    ) {
      fail(`destination ${destination.path}`, "current bytes do not match the structured inventory")
    }
  }

  await scanBranding(projectRoot, manifest.brandingPolicy)
  await verifyDependencyBoundary(projectRoot)
  return { manifest, manifestSha256 }
}
