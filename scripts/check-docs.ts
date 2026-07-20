import { constants, type Stats } from "node:fs"
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises"
import { dirname, extname, isAbsolute, parse, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { Nodes } from "mdast"
import { fromMarkdown } from "mdast-util-from-markdown"

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const MAX_DOCUMENTATION_INPUT_BYTES = 16 * 1024 * 1024
const MAX_DOCUMENTATION_REPORT_BYTES = 16 * 1024 * 1024
const excludedDirectories = new Set([
  ".git",
  ".ralph",
  "artifacts",
  "coverage",
  "dist",
  "node_modules",
])

function containsC0OrDeleteControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true
  }
  return false
}

interface DocumentationIssue {
  readonly kind:
    | "invalid-link"
    | "missing-path"
    | "missing-anchor"
    | "unknown-package-script"
    | "unsafe-path"
  readonly file: string
  readonly line: number
  readonly value: string
  readonly message: string
}

interface LocalLink {
  readonly target: string
  readonly line: number
  readonly invalidReason?: string
}

interface ParsedMarkdownDocument {
  readonly anchors: ReadonlySet<string>
  readonly links: readonly LocalLink[]
}

export interface DocumentationCheckResult {
  readonly schemaVersion: 1
  readonly artifactClass: "documentation-structure-check"
  readonly status: "pass" | "fail"
  readonly root: "."
  readonly counts: {
    readonly markdownFiles: number
    readonly localLinks: number
    readonly packageScriptReferences: number
    readonly issues: number
  }
  readonly issues: readonly DocumentationIssue[]
}

interface CheckDocumentationOptions {
  readonly root?: string
}

interface PathWalk {
  readonly exists: boolean
  readonly deepestExisting: string
  readonly information: Stats | undefined
}

interface SecurePathInspection {
  readonly absolute: string
  readonly exists: boolean
  readonly information: Stats | undefined
}

type DestinationAvailability =
  | { readonly kind: "exists"; readonly information: Stats }
  | { readonly kind: "missing" }
  | { readonly kind: "unsafe"; readonly message: string }

export class UnsafeDocumentationPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnsafeDocumentationPathError"
  }
}

function portable(path: string, root = projectRoot): string {
  return relative(root, path).replaceAll("\\", "/") || "."
}

function insideRoot(root: string, path: string): boolean {
  const rootRelative = relative(root, path)
  return rootRelative !== ".." && !rootRelative.startsWith(".." + sep) && !isAbsolute(rootRelative)
}

function comparisonPath(path: string): string {
  if (process.platform !== "win32") return resolve(path).replaceAll("\\", "/")

  let requested = path.replaceAll("\\", "/")
  if (requested.toLowerCase().startsWith("//?/unc/")) {
    requested = `//${requested.slice("//?/UNC/".length)}`
  } else if (requested.startsWith("//?/")) {
    requested = requested.slice("//?/".length)
  }
  if (/^[a-z]:$/iu.test(requested)) requested += "/"
  return resolve(requested).replaceAll("\\", "/").toLowerCase()
}

export function sameCanonicalPath(left: string, right: string): boolean {
  return comparisonPath(left) === comparisonPath(right)
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  )
}

async function lstatIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path)
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

async function assertCanonicalComponent(path: string, information: Stats): Promise<void> {
  if (information.isSymbolicLink()) {
    throw new UnsafeDocumentationPathError(
      "Documentation path traverses a symbolic link, junction, or reparse point: " + path,
    )
  }
  const canonical = await realpath(path)
  if (!sameCanonicalPath(path, canonical)) {
    throw new UnsafeDocumentationPathError(
      "Documentation path is redirected by a junction or reparse point: " + path,
    )
  }
}

async function inspectPathWithoutRedirects(path: string): Promise<PathWalk> {
  const absolute = resolve(path)
  const volumeRoot = parse(absolute).root
  const rootInformation = await lstat(volumeRoot)
  await assertCanonicalComponent(volumeRoot, rootInformation)
  let current = volumeRoot
  let information = rootInformation
  const remainder = relative(volumeRoot, absolute)
  const segments = remainder === "" ? [] : remainder.split(sep)
  for (const segment of segments) {
    const requested = resolve(current, segment)
    const found = await lstatIfPresent(requested)
    if (!found) {
      return {
        exists: false,
        deepestExisting: current,
        information: undefined,
      }
    }
    await assertCanonicalComponent(requested, found)
    current = requested
    information = found
  }
  return {
    exists: true,
    deepestExisting: current,
    information,
  }
}

async function inspectSecurePath(
  rootPath: string,
  candidatePath: string,
): Promise<SecurePathInspection> {
  const root = resolve(rootPath)
  const absolute = resolve(candidatePath)
  if (!insideRoot(root, absolute)) {
    throw new UnsafeDocumentationPathError(
      "Documentation path escapes the project root: " + absolute,
    )
  }
  const rootWalk = await inspectPathWithoutRedirects(root)
  if (!rootWalk.exists || !rootWalk.information?.isDirectory()) {
    throw new UnsafeDocumentationPathError(
      "Documentation root must be an existing regular directory: " + root,
    )
  }
  const canonicalRoot = await realpath(root)
  if (!sameCanonicalPath(root, canonicalRoot)) {
    throw new UnsafeDocumentationPathError(
      "Documentation root must not be a symbolic link, junction, or reparse point: " + root,
    )
  }
  const candidateWalk = await inspectPathWithoutRedirects(absolute)
  const canonicalAncestor = await realpath(candidateWalk.deepestExisting)
  if (!insideRoot(canonicalRoot, canonicalAncestor)) {
    throw new UnsafeDocumentationPathError(
      "Documentation path resolves outside the project root: " + absolute,
    )
  }
  return {
    absolute,
    exists: candidateWalk.exists,
    information: candidateWalk.information,
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function sameFileObject(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function readSecureText(root: string, path: string): Promise<string> {
  const inspection = await inspectSecurePath(root, path)
  const initial = inspection.information
  if (!inspection.exists || !initial?.isFile() || initial.isSymbolicLink()) {
    throw new UnsafeDocumentationPathError(
      "Documentation input must be a regular non-link file: " + inspection.absolute,
    )
  }
  if (
    !Number.isSafeInteger(initial.size) ||
    initial.size < 0 ||
    initial.size > MAX_DOCUMENTATION_INPUT_BYTES
  ) {
    throw new UnsafeDocumentationPathError(
      "Documentation input exceeds the bounded byte limit: " + inspection.absolute,
    )
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
  const handle = await open(inspection.absolute, constants.O_RDONLY | noFollow)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameFileIdentity(initial, opened)) {
      throw new UnsafeDocumentationPathError(
        "Documentation input changed before it was opened: " + inspection.absolute,
      )
    }
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < opened.size) {
      const read = await handle.read(bytes, offset, opened.size - offset, offset)
      if (read.bytesRead <= 0) {
        throw new UnsafeDocumentationPathError(
          "Documentation input ended before its declared size: " + inspection.absolute,
        )
      }
      offset += read.bytesRead
    }
    const overflow = Buffer.alloc(1)
    if ((await handle.read(overflow, 0, 1, opened.size)).bytesRead !== 0) {
      throw new UnsafeDocumentationPathError(
        "Documentation input grew beyond its bounded size: " + inspection.absolute,
      )
    }
    let source: string
    try {
      source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      throw new UnsafeDocumentationPathError(
        "Documentation input is not valid UTF-8: " + inspection.absolute,
      )
    }
    const settled = await handle.stat()
    if (!sameFileIdentity(opened, settled)) {
      throw new UnsafeDocumentationPathError(
        "Documentation input changed while it was read: " + inspection.absolute,
      )
    }
    const after = await inspectSecurePath(root, inspection.absolute)
    if (
      !after.exists ||
      !after.information?.isFile() ||
      !sameFileIdentity(settled, after.information)
    ) {
      throw new UnsafeDocumentationPathError(
        "Documentation input path changed while it was read: " + inspection.absolute,
      )
    }
    return source
  } finally {
    await handle.close()
  }
}

async function collectMarkdownFiles(root: string, directory = root): Promise<readonly string[]> {
  const inspectedDirectory = await inspectSecurePath(root, directory)
  if (!inspectedDirectory.exists || !inspectedDirectory.information?.isDirectory()) {
    throw new UnsafeDocumentationPathError(
      "Documentation scan path must be a regular directory: " + directory,
    )
  }
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name, "en"),
  )
  const files: string[] = []
  for (const entry of entries) {
    if (excludedDirectories.has(entry.name)) continue
    const path = resolve(directory, entry.name)
    if (entry.isSymbolicLink()) {
      throw new UnsafeDocumentationPathError(
        "Documentation scan rejects symbolic links, junctions and reparse points: " + path,
      )
    }
    if (entry.isDirectory()) {
      const inspected = await inspectSecurePath(root, path)
      if (!inspected.exists || !inspected.information?.isDirectory()) {
        throw new UnsafeDocumentationPathError(
          "Documentation scan directory changed identity: " + path,
        )
      }
      files.push(...(await collectMarkdownFiles(root, path)))
      continue
    }
    if (entry.isFile()) {
      if (extname(entry.name).toLowerCase() !== ".md") continue
      const inspected = await inspectSecurePath(root, path)
      if (!inspected.exists || !inspected.information?.isFile()) {
        throw new UnsafeDocumentationPathError("Documentation scan file changed identity: " + path)
      }
      files.push(path)
      continue
    }
    throw new UnsafeDocumentationPathError(
      "Documentation scan rejects non-regular filesystem entries: " + path,
    )
  }
  return files
}

function childrenOf(node: Nodes): readonly Nodes[] {
  if ("children" in node && Array.isArray(node.children)) return node.children
  return []
}

function markdownNodeText(node: Nodes): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
      return node.value
    case "image":
      return node.alt ?? ""
    case "break":
      return " "
    case "html":
    case "code":
      return ""
    default:
      return childrenOf(node).map(markdownNodeText).join("")
  }
}

function githubSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/gu, "")
    .replace(/[\x60*_~]/gu, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-")
}

function parseMarkdownDocument(source: string): ParsedMarkdownDocument {
  const links: LocalLink[] = []
  const anchors = new Set<string>()
  const occurrences = new Map<string, number>()
  const tree = fromMarkdown(source)
  const definitions = new Map<string, string>()
  const explicitAnchor =
    /<(?:a\s+(?:[^>]*?\s)?(?:id|name)|[a-z][\w:-]*\s+(?:[^>]*?\s)?id)=["']([^"']+)["'][^>]*>/giu
  const collectDefinitions = (node: Nodes): void => {
    if (node.type === "definition" && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url)
    }
    for (const child of childrenOf(node)) collectDefinitions(child)
  }
  collectDefinitions(tree)

  /**
   * Contract: this checker follows CommonMark link/image nodes and resolved
   * linkReference/imageReference nodes. Raw HTML href/src attributes are not
   * links in this contract; HTML is inspected only for explicit id/name anchors.
   */
  const visit = (node: Nodes): void => {
    if (node.type === "link" || node.type === "image") {
      links.push({
        target: node.url,
        line: node.position?.start.line ?? 1,
      })
    }
    if (node.type === "linkReference" || node.type === "imageReference") {
      const target = definitions.get(node.identifier)
      links.push({
        target: target ?? node.identifier,
        line: node.position?.start.line ?? 1,
        ...(target === undefined
          ? { invalidReason: "CommonMark reference has no matching definition." }
          : {}),
      })
    }
    if (node.type === "heading") {
      const base = githubSlug(markdownNodeText(node))
      if (base) {
        const occurrence = occurrences.get(base) ?? 0
        occurrences.set(base, occurrence + 1)
        anchors.add(occurrence === 0 ? base : base + "-" + occurrence)
      }
    }
    if (node.type === "html") {
      for (const match of node.value.matchAll(explicitAnchor)) {
        if (match[1]) anchors.add(match[1])
      }
    }
    for (const child of childrenOf(node)) visit(child)
  }
  visit(tree)
  links.sort(
    (left, right) => left.line - right.line || left.target.localeCompare(right.target, "en"),
  )
  return { anchors, links }
}

function lineNumber(source: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1
  }
  return line
}

function isLocalTarget(target: string): boolean {
  if (!target || target.startsWith("//")) return false
  return !/^[a-z][a-z\d+.-]*:/iu.test(target)
}

interface DecodedLocalTarget {
  readonly path: string
  readonly anchor: string
}

function decodeLocalTarget(value: string): DecodedLocalTarget | null {
  const hashOffset = value.indexOf("#")
  const beforeFragment = hashOffset >= 0 ? value.slice(0, hashOffset) : value
  const queryOffset = beforeFragment.indexOf("?")
  const encodedPath = queryOffset >= 0 ? beforeFragment.slice(0, queryOffset) : beforeFragment
  const encodedAnchor = hashOffset >= 0 ? value.slice(hashOffset + 1) : ""
  try {
    const path = decodeURIComponent(encodedPath).replaceAll("\\", "/")
    const anchor = decodeURIComponent(encodedAnchor)
    if (containsC0OrDeleteControl(path) || containsC0OrDeleteControl(anchor)) {
      return null
    }
    return { path, anchor }
  } catch {
    return null
  }
}

async function destinationAvailability(
  root: string,
  destination: string,
): Promise<DestinationAvailability> {
  try {
    const inspection = await inspectSecurePath(root, destination)
    if (!inspection.exists || !inspection.information) return { kind: "missing" }
    if (!inspection.information.isFile() && !inspection.information.isDirectory()) {
      return {
        kind: "unsafe",
        message: "Local link destination is not a regular file or directory.",
      }
    }
    return { kind: "exists", information: inspection.information }
  } catch (error) {
    if (error instanceof UnsafeDocumentationPathError) {
      return {
        kind: "unsafe",
        message:
          "Local link traverses a symbolic link, junction, reparse point, or canonical escape.",
      }
    }
    throw error
  }
}

function packageScriptReferences(source: string): readonly { name: string; offset: number }[] {
  const references: { name: string; offset: number }[] = []
  const command = /\bbun\s+run\s+(?:(?:--[\w-]+(?:=\S+)?|-\w)\s+)*([^\s\x60"'|;&]+)/gu
  for (const match of source.matchAll(command)) {
    const name = match[1]?.replace(/[),.:]+$/u, "") ?? ""
    if (
      !name ||
      name.startsWith("<") ||
      name.startsWith("$") ||
      name.startsWith(".") ||
      name.includes("/") ||
      name.includes("\\") ||
      /\.(?:[cm]?[jt]s|tsx)$/iu.test(name)
    ) {
      continue
    }
    references.push({ name, offset: match.index })
  }
  return references
}

export async function checkDocumentation(
  options: CheckDocumentationOptions = {},
): Promise<DocumentationCheckResult> {
  const root = resolve(options.root ?? projectRoot)
  const rootInspection = await inspectSecurePath(root, root)
  if (!rootInspection.exists || !rootInspection.information?.isDirectory()) {
    throw new UnsafeDocumentationPathError(
      "Documentation root must be an existing regular directory: " + root,
    )
  }
  const packageManifest = JSON.parse(await readSecureText(root, resolve(root, "package.json"))) as {
    readonly scripts?: Readonly<Record<string, unknown>>
  }
  const scripts = new Set(
    Object.entries(packageManifest.scripts ?? {})
      .filter(([, value]) => typeof value === "string")
      .map(([name]) => name),
  )
  const files = await collectMarkdownFiles(root)
  const issues: DocumentationIssue[] = []
  const documentCache = new Map<
    string,
    { readonly source: string; readonly parsed: ParsedMarkdownDocument }
  >()
  const loadDocument = async (
    file: string,
  ): Promise<{ readonly source: string; readonly parsed: ParsedMarkdownDocument }> => {
    const absolute = resolve(file)
    const cached = documentCache.get(absolute)
    if (cached) return cached
    const source = await readSecureText(root, absolute)
    const document = { source, parsed: parseMarkdownDocument(source) }
    documentCache.set(absolute, document)
    return document
  }
  let localLinks = 0
  let scriptReferences = 0

  for (const file of files) {
    const document = await loadDocument(file)
    const source = document.source
    for (const link of document.parsed.links) {
      if (link.invalidReason) {
        localLinks += 1
        issues.push({
          kind: "invalid-link",
          file: portable(file, root),
          line: link.line,
          value: link.target,
          message: link.invalidReason,
        })
        continue
      }
      if (!isLocalTarget(link.target)) continue
      localLinks += 1
      const decoded = decodeLocalTarget(link.target)
      const fileName = portable(file, root)
      if (decoded === null) {
        issues.push({
          kind: "invalid-link",
          file: fileName,
          line: link.line,
          value: link.target,
          message: "Local link contains invalid percent encoding or control characters.",
        })
        continue
      }
      const destination = decoded.path ? resolve(dirname(file), decoded.path) : file
      if (!insideRoot(root, destination)) {
        issues.push({
          kind: "missing-path",
          file: fileName,
          line: link.line,
          value: link.target,
          message: "Local link escapes the project root.",
        })
        continue
      }
      const availability = await destinationAvailability(root, destination)
      if (availability.kind === "missing") {
        issues.push({
          kind: "missing-path",
          file: fileName,
          line: link.line,
          value: link.target,
          message: "Local path does not exist: " + portable(destination, root),
        })
        continue
      }
      if (availability.kind === "unsafe") {
        issues.push({
          kind: "unsafe-path",
          file: fileName,
          line: link.line,
          value: link.target,
          message: availability.message,
        })
        continue
      }
      if (
        decoded.anchor &&
        extname(destination).toLowerCase() === ".md" &&
        availability.information.isFile()
      ) {
        const destinationDocument = await loadDocument(destination)
        if (!destinationDocument.parsed.anchors.has(decoded.anchor)) {
          issues.push({
            kind: "missing-anchor",
            file: fileName,
            line: link.line,
            value: link.target,
            message: "Markdown anchor does not exist: #" + decoded.anchor,
          })
        }
      }
    }

    for (const reference of packageScriptReferences(source)) {
      scriptReferences += 1
      if (!scripts.has(reference.name)) {
        issues.push({
          kind: "unknown-package-script",
          file: portable(file, root),
          line: lineNumber(source, reference.offset),
          value: reference.name,
          message: "package.json has no script named " + reference.name + ".",
        })
      }
    }
  }

  issues.sort(
    (left, right) =>
      left.file.localeCompare(right.file, "en") ||
      left.line - right.line ||
      left.kind.localeCompare(right.kind, "en") ||
      left.value.localeCompare(right.value, "en"),
  )
  return {
    schemaVersion: 1,
    artifactClass: "documentation-structure-check",
    status: issues.length === 0 ? "pass" : "fail",
    root: ".",
    counts: {
      markdownFiles: files.length,
      localLinks,
      packageScriptReferences: scriptReferences,
      issues: issues.length,
    },
    issues,
  }
}

async function ensureSecureDirectory(root: string, directory: string): Promise<void> {
  const absoluteRoot = resolve(root)
  const absoluteDirectory = resolve(directory)
  if (!insideRoot(absoluteRoot, absoluteDirectory)) {
    throw new UnsafeDocumentationPathError(
      "Documentation output directory escapes the project root: " + absoluteDirectory,
    )
  }
  const rootInspection = await inspectSecurePath(absoluteRoot, absoluteRoot)
  if (!rootInspection.exists || !rootInspection.information?.isDirectory()) {
    throw new UnsafeDocumentationPathError(
      "Documentation output root must be a regular directory: " + absoluteRoot,
    )
  }
  const remainder = relative(absoluteRoot, absoluteDirectory)
  if (remainder === "") return
  let current = absoluteRoot
  for (const segment of remainder.split(sep)) {
    current = resolve(current, segment)
    const existing = await inspectSecurePath(absoluteRoot, current)
    if (!existing.exists) await mkdir(current, { recursive: false })
    const settled = await inspectSecurePath(absoluteRoot, current)
    if (!settled.exists || !settled.information?.isDirectory()) {
      throw new UnsafeDocumentationPathError(
        "Documentation output ancestor is not a regular directory: " + current,
      )
    }
  }
}

export async function writeDocumentationReport(
  result: DocumentationCheckResult,
  output: string,
  rootPath = projectRoot,
): Promise<string> {
  const root = resolve(rootPath)
  const absoluteOutput = resolve(root, output)
  const payload = new TextEncoder().encode(JSON.stringify(result, null, 2) + "\n")
  if (payload.byteLength > MAX_DOCUMENTATION_REPORT_BYTES) {
    throw new UnsafeDocumentationPathError(
      "Documentation report exceeds the bounded byte limit: " + absoluteOutput,
    )
  }
  if (!insideRoot(root, absoluteOutput)) {
    throw new UnsafeDocumentationPathError(
      "Documentation report must remain inside the project: " + output,
    )
  }
  await ensureSecureDirectory(root, dirname(absoluteOutput))
  const initial = await inspectSecurePath(root, absoluteOutput)
  if (initial.exists && (!initial.information?.isFile() || initial.information.isSymbolicLink())) {
    throw new UnsafeDocumentationPathError(
      "Documentation report destination must be a regular non-link file: " + absoluteOutput,
    )
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
  const createFlags =
    initial.information === undefined
      ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow
      : constants.O_WRONLY | noFollow
  const handle = await open(absoluteOutput, createFlags, 0o600)
  let opened: Stats | undefined
  try {
    opened = await handle.stat()
    if (
      !opened.isFile() ||
      (initial.information !== undefined && !sameFileIdentity(initial.information, opened))
    ) {
      throw new UnsafeDocumentationPathError(
        "Documentation report destination changed before it was opened: " + absoluteOutput,
      )
    }
    await handle.truncate(0)
    await handle.writeFile(payload)
    await handle.sync()
  } finally {
    await handle.close()
  }
  const settled = await inspectSecurePath(root, absoluteOutput)
  if (
    !opened ||
    !settled.exists ||
    !settled.information?.isFile() ||
    !sameFileObject(opened, settled.information)
  ) {
    throw new UnsafeDocumentationPathError(
      "Documentation report destination changed while it was written: " + absoluteOutput,
    )
  }
  return absoluteOutput
}

function requiredValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith("--")) throw new Error(flag + " requires a value")
  return value
}

function outputArgument(argv: readonly string[]): string | null {
  let output: string | null = null
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === "--") continue
    if (flag !== "--output") throw new Error("Unknown argument: " + (flag ?? "<missing>"))
    output = requiredValue(argv, index, flag)
    index += 1
  }
  return output
}

if (import.meta.main) {
  const output = outputArgument(process.argv.slice(2))
  const result = await checkDocumentation()
  if (output) await writeDocumentationReport(result, output)
  process.stdout.write(JSON.stringify(result) + "\n")
  if (result.status === "fail") process.exitCode = 1
}
