import { createHash } from "node:crypto"
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { z } from "zod"

const MAX_REPORTS = 16
const MAX_REPORT_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_REPORT_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_TESTCASES = 100_000
const MAX_XML_DEPTH = 32
const MAX_XML_ELEMENTS_PER_REPORT = 250_000
const MAX_ATTRIBUTES_PER_ELEMENT = 64
const MAX_ATTRIBUTE_VALUE_LENGTH = 16_384
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_WAIVERS = 5_000

const OsSchema = z.enum(["windows", "linux", "macos"])
const ArchitectureSchema = z.enum(["x64", "arm64"])
const KindSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/u)

function containsC0(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && codePoint <= 0x1f) return true
  }
  return false
}

function safeTrimmedString(minimum: number, maximum: number) {
  return z
    .string()
    .trim()
    .min(minimum)
    .max(maximum)
    .refine((value) => !containsC0(value), "must not contain C0 controls")
}

const WaiverSchema = z
  .object({
    kind: KindSchema,
    report: safeTrimmedString(1, 255),
    file: safeTrimmedString(1, 1_024),
    testName: safeTrimmedString(1, 4_096),
    os: OsSchema,
    architecture: ArchitectureSchema,
    owner: safeTrimmedString(1, 128),
    rationale: safeTrimmedString(20, 2_048),
    approvalRef: safeTrimmedString(1, 512),
    expiresOn: z
      .string()
      .trim()
      .length(10)
      .regex(/^\d{4}-\d{2}-\d{2}$/u),
  })
  .strict()
const WaiverManifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    waivers: z.array(WaiverSchema).max(MAX_WAIVERS),
  })
  .strict()

type CiOs = z.infer<typeof OsSchema>
type CiArchitecture = z.infer<typeof ArchitectureSchema>
type ManifestWaiver = z.infer<typeof WaiverSchema>
type TestStatus = "passed" | "failed" | "error" | "skipped"

interface Waiver extends Omit<ManifestWaiver, "file"> {
  readonly file: string
}

interface Arguments {
  readonly kind: string
  readonly input: string
  readonly output: string
  readonly waivers: string
  readonly expectedReports: readonly string[]
  readonly expectedOs?: string
  readonly expectedArchitecture?: string
}

interface TestCaseResult {
  readonly name: string
  readonly className: string | null
  readonly file: string
  readonly status: TestStatus
}

interface ParsedReport {
  readonly name: string
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  readonly cases: readonly TestCaseResult[]
}

interface XmlElement {
  readonly name: string
  readonly attributes: ReadonlyMap<string, string>
  readonly children: XmlElement[]
  hasNonWhitespaceText: boolean
}

interface SuiteCounts {
  readonly tests: number
  readonly passed: number
  readonly failed: number
  readonly errors: number
  readonly skipped: number
}

const projectRoot = resolve(import.meta.dir, "../..")

function requiredValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`)
  return value
}

function normalizedReportName(value: string, label: string): string {
  const report = value.trim()
  if (
    report.length === 0 ||
    report.length > 255 ||
    containsC0(report) ||
    basename(report) !== report ||
    !report.toLowerCase().endsWith(".xml")
  ) {
    throw new Error(`${label} must be a plain, bounded XML file name: ${value}`)
  }
  return report
}

function parseArguments(argv: readonly string[]): Arguments {
  let kind: string | undefined
  let input: string | undefined
  let output: string | undefined
  let waivers: string | undefined
  let expectedOs: string | undefined
  let expectedArchitecture: string | undefined
  const expectedReports: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === "--") continue
    const value = requiredValue(argv, index, flag ?? "<missing>")
    if (flag === "--kind") kind = value
    else if (flag === "--input") input = value
    else if (flag === "--output") output = value
    else if (flag === "--waivers") waivers = value
    else if (flag === "--expect") expectedReports.push(normalizedReportName(value, "--expect"))
    else if (flag === "--expected-os") expectedOs = value
    else if (flag === "--expected-arch") expectedArchitecture = value
    else throw new Error(`Unknown argument: ${flag ?? "<missing>"}`)
    index += 1
  }

  if (!kind) throw new Error("--kind is required")
  const parsedKind = KindSchema.parse(kind)
  if (!input) throw new Error("--input is required")
  if (!output) throw new Error("--output is required")
  if (!waivers) throw new Error("--waivers is required")
  if (expectedReports.length === 0) throw new Error("At least one --expect is required")
  if (expectedReports.length > MAX_REPORTS) {
    throw new Error(`At most ${MAX_REPORTS} expected JUnit reports are allowed`)
  }
  if (new Set(expectedReports).size !== expectedReports.length) {
    throw new Error("Expected report names must be unique")
  }
  return {
    kind: parsedKind,
    input,
    output,
    waivers,
    expectedReports,
    ...(expectedOs ? { expectedOs } : {}),
    ...(expectedArchitecture ? { expectedArchitecture } : {}),
  }
}

function insideProject(path: string, label: string): string {
  const absolute = resolve(projectRoot, path)
  const projectRelative = relative(projectRoot, absolute)
  if (
    projectRelative === ".." ||
    projectRelative.startsWith(`..${sep}`) ||
    isAbsolute(projectRelative)
  ) {
    throw new Error(`${label} must remain inside the project: ${path}`)
  }
  return absolute
}

function portableProjectPath(path: string): string {
  return relative(projectRoot, path).replaceAll("\\", "/")
}

function normalizeOs(value: string): CiOs {
  const normalized = value.trim().toLowerCase()
  if (normalized === "win32" || normalized === "windows") return "windows"
  if (normalized === "linux") return "linux"
  if (normalized === "darwin" || normalized === "macos" || normalized === "mac") return "macos"
  throw new Error(`Unsupported operating system: ${value}`)
}

function normalizeArchitecture(value: string): CiArchitecture {
  const normalized = value.trim().toLowerCase()
  if (normalized === "x64" || normalized === "amd64" || normalized === "x86_64") return "x64"
  if (normalized === "arm64" || normalized === "aarch64") return "arm64"
  throw new Error(`Unsupported architecture: ${value}`)
}

function normalizeTestFile(value: string, label: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 1_024 || containsC0(trimmed)) {
    throw new Error(`${label} must be a non-empty, bounded, C0-safe path`)
  }
  let portable = trimmed.replaceAll("\\", "/")
  while (portable.startsWith("./")) portable = portable.slice(2)
  if (
    portable.length === 0 ||
    portable.startsWith("/") ||
    /^[A-Za-z]:/u.test(portable) ||
    portable
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be a normalized project-relative file path: ${value}`)
  }
  return portable
}

function isXmlCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0d ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  )
}

function assertXmlCharacters(value: string, sourcePath: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index)
    if (codePoint === undefined || !isXmlCodePoint(codePoint)) {
      throw new Error(`${sourcePath} contains a character forbidden by XML 1.0`)
    }
    if (codePoint > 0xffff) index += 1
  }
}

function decodeXml(value: string): string {
  let cursor = 0
  let decoded = ""
  const entityPattern = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/giu
  for (const match of value.matchAll(entityPattern)) {
    const offset = match.index
    const literal = match[0]
    const prefix = value.slice(cursor, offset)
    if (prefix.includes("&")) throw new Error("JUnit XML contains an invalid entity reference")
    decoded += prefix
    if (literal === "&amp;") decoded += "&"
    else if (literal === "&lt;") decoded += "<"
    else if (literal === "&gt;") decoded += ">"
    else if (literal === "&quot;") decoded += '"'
    else if (literal === "&apos;") decoded += "'"
    else {
      const hexadecimal = literal.toLowerCase().startsWith("&#x")
      const digits = literal.slice(hexadecimal ? 3 : 2, -1)
      const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10)
      if (!Number.isSafeInteger(codePoint) || !isXmlCodePoint(codePoint)) {
        throw new Error(`JUnit XML contains an invalid code point: ${literal}`)
      }
      decoded += String.fromCodePoint(codePoint)
    }
    cursor = offset + literal.length
  }
  const suffix = value.slice(cursor)
  if (suffix.includes("&")) throw new Error("JUnit XML contains an invalid entity reference")
  return decoded + suffix
}

function parseAttributes(source: string): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>()
  let cursor = 0
  while (cursor < source.length) {
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1
    if (cursor >= source.length) break
    const nameMatch = /^[A-Za-z_][\w:.-]*/u.exec(source.slice(cursor))
    if (!nameMatch) {
      throw new Error(`Malformed JUnit XML attribute near: ${source.slice(cursor, cursor + 80)}`)
    }
    const name = nameMatch[0]
    cursor += name.length
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1
    if (source[cursor] !== "=") throw new Error(`JUnit XML attribute ${name} has no equals sign`)
    cursor += 1
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1
    const quote = source[cursor]
    if (quote !== '"' && quote !== "'") {
      throw new Error(`JUnit XML attribute ${name} must use a quoted value`)
    }
    cursor += 1
    const end = source.indexOf(quote, cursor)
    if (end < 0) throw new Error(`JUnit XML attribute ${name} has no closing quote`)
    const raw = source.slice(cursor, end)
    if (raw.length > MAX_ATTRIBUTE_VALUE_LENGTH) {
      throw new Error(`JUnit XML attribute ${name} exceeds the value-size limit`)
    }
    if (raw.includes("<")) throw new Error(`JUnit XML attribute ${name} contains an unescaped <`)
    if (attributes.has(name)) throw new Error(`Duplicate JUnit XML attribute: ${name}`)
    const decoded = decodeXml(raw)
    if (decoded.length > MAX_ATTRIBUTE_VALUE_LENGTH) {
      throw new Error(`JUnit XML attribute ${name} exceeds the decoded value-size limit`)
    }
    attributes.set(name, decoded)
    if (attributes.size > MAX_ATTRIBUTES_PER_ELEMENT) {
      throw new Error(`JUnit XML element exceeds ${MAX_ATTRIBUTES_PER_ELEMENT} attributes`)
    }
    cursor = end + 1
  }
  return attributes
}

function readTagEnd(xml: string, start: number): number {
  let quote: '"' | "'" | null = null
  for (let cursor = start; cursor < xml.length; cursor += 1) {
    const character = xml[cursor]
    if (quote) {
      if (character === quote) quote = null
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === ">") {
      return cursor
    }
  }
  throw new Error("JUnit XML contains a truncated element")
}

function parseElementStart(source: string): {
  readonly name: string
  readonly attributes: ReadonlyMap<string, string>
  readonly selfClosing: boolean
} {
  let normalized = source.trim()
  const selfClosing = normalized.endsWith("/")
  if (selfClosing) normalized = normalized.slice(0, -1).trimEnd()
  const nameMatch = /^[A-Za-z_][\w:.-]*/u.exec(normalized)
  if (!nameMatch) throw new Error(`Malformed JUnit XML element: <${source}>`)
  const name = nameMatch[0]
  const remainder = normalized.slice(name.length)
  if (remainder.length > 0 && !/^\s/u.test(remainder)) {
    throw new Error(`Malformed JUnit XML element name: ${normalized}`)
  }
  return { name, attributes: parseAttributes(remainder), selfClosing }
}

function parseXmlDocument(source: string, sourcePath: string): XmlElement {
  let xml = source
  if (xml.startsWith("\uFEFF")) xml = xml.slice(1)
  assertXmlCharacters(xml, sourcePath)
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) {
    throw new Error(`${sourcePath} uses a forbidden DTD or entity declaration`)
  }

  let cursor = 0
  let root: XmlElement | null = null
  let rootClosed = false
  let declarationSeen = false
  let elements = 0
  const stack: XmlElement[] = []

  while (cursor < xml.length) {
    const opening = xml.indexOf("<", cursor)
    const text = xml.slice(cursor, opening < 0 ? xml.length : opening)
    if (text.includes("]]>")) {
      throw new Error(`${sourcePath} contains forbidden ]]> character data`)
    }
    decodeXml(text)
    const textParent = stack.at(-1)
    if (textParent && text.trim().length > 0) textParent.hasNonWhitespaceText = true
    if (stack.length === 0 && text.trim().length > 0) {
      throw new Error(`${sourcePath} contains content outside its root element`)
    }
    if (opening < 0) {
      cursor = xml.length
      break
    }
    if (xml.startsWith("<?", opening)) {
      const end = xml.indexOf("?>", opening + 2)
      if (end < 0) throw new Error(`${sourcePath} contains a truncated processing instruction`)
      const instruction = xml.slice(opening + 2, end).trim()
      if (
        declarationSeen ||
        root !== null ||
        stack.length > 0 ||
        opening !== 0 ||
        !instruction.startsWith("xml") ||
        (instruction.length > 3 && !/\s/u.test(instruction[3] ?? ""))
      ) {
        throw new Error(`${sourcePath} contains a forbidden processing instruction`)
      }
      const declaration = parseAttributes(instruction.slice(3))
      if (declaration.get("version") !== "1.0") {
        throw new Error(`${sourcePath} must declare XML version 1.0`)
      }
      const encoding = declaration.get("encoding")
      if (encoding && encoding.toLowerCase() !== "utf-8") {
        throw new Error(`${sourcePath} must use UTF-8 XML encoding`)
      }
      const standalone = declaration.get("standalone")
      if (standalone && standalone !== "yes" && standalone !== "no") {
        throw new Error(`${sourcePath} has an invalid XML standalone declaration`)
      }
      for (const name of declaration.keys()) {
        if (name !== "version" && name !== "encoding" && name !== "standalone") {
          throw new Error(`${sourcePath} has an unsupported XML declaration attribute: ${name}`)
        }
      }
      declarationSeen = true
      cursor = end + 2
      continue
    }
    if (xml.startsWith("<!", opening)) {
      throw new Error(
        `${sourcePath} contains a forbidden XML declaration, comment, or CDATA section`,
      )
    }

    const end = readTagEnd(xml, opening + 1)
    const body = xml.slice(opening + 1, end)
    if (body.startsWith("/")) {
      const closing = body.slice(1).trim()
      if (!/^[A-Za-z_][\w:.-]*$/u.test(closing)) {
        throw new Error(`${sourcePath} contains a malformed closing element: </${closing}>`)
      }
      const current = stack.pop()
      if (!current || current.name !== closing) {
        throw new Error(`${sourcePath} has an unbalanced closing element: </${closing}>`)
      }
      if (stack.length === 0) rootClosed = true
      cursor = end + 1
      continue
    }

    if (rootClosed && stack.length === 0) {
      throw new Error(`${sourcePath} contains a second root element or trailing content`)
    }
    const parsed = parseElementStart(body)
    const element: XmlElement = {
      name: parsed.name,
      attributes: parsed.attributes,
      children: [],
      hasNonWhitespaceText: false,
    }
    elements += 1
    if (elements > MAX_XML_ELEMENTS_PER_REPORT) {
      throw new Error(`${sourcePath} exceeds the XML element limit`)
    }
    const parent = stack.at(-1)
    if (parent) parent.children.push(element)
    else {
      if (root) throw new Error(`${sourcePath} contains more than one root element`)
      root = element
    }
    if (!parsed.selfClosing) {
      stack.push(element)
      if (stack.length > MAX_XML_DEPTH) {
        throw new Error(`${sourcePath} exceeds the XML nesting-depth limit`)
      }
    } else if (!parent) {
      rootClosed = true
    }
    cursor = end + 1
  }

  if (!root) throw new Error(`${sourcePath} has no root element`)
  if (stack.length > 0 || !rootClosed) {
    throw new Error(
      `${sourcePath} contains an unclosed element: <${stack.at(-1)?.name ?? root.name}>`,
    )
  }
  return root
}

function boundedCaseString(
  raw: string | undefined,
  label: string,
  maximum: number,
  required: boolean,
): string | null {
  const value = raw?.trim() ?? ""
  if (!value) {
    if (required) throw new Error(`${label} is required`)
    return null
  }
  if (value.length > maximum || containsC0(value)) {
    throw new Error(`${label} must be bounded and C0-safe`)
  }
  return value
}

function declaredCount(
  attributes: ReadonlyMap<string, string>,
  name: string,
  sourcePath: string,
  required: boolean,
): number | null {
  const raw = attributes.get(name)
  if (raw === undefined) {
    if (required) throw new Error(`${sourcePath} does not declare its ${name} count`)
    return null
  }
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`${sourcePath} has an invalid ${name} count: ${raw}`)
  }
  const count = Number(raw)
  if (!Number.isSafeInteger(count) || count > MAX_TOTAL_TESTCASES) {
    throw new Error(`${sourcePath} has an unsafe or excessive ${name} count: ${raw}`)
  }
  return count
}

function statusFromAttribute(value: string, sourcePath: string, testName: string): TestStatus {
  const normalized = value.trim().toLowerCase()
  if (["pass", "passed", "success", "successful"].includes(normalized)) return "passed"
  if (["fail", "failed", "failure"].includes(normalized)) return "failed"
  if (normalized === "error") return "error"
  if (["skip", "skipped", "disabled", "pending", "todo", "ignored"].includes(normalized)) {
    return "skipped"
  }
  throw new Error(`${sourcePath} gives testcase ${testName} an unknown status: ${value}`)
}

function parseTestCase(element: XmlElement, sourcePath: string): TestCaseResult {
  const name = boundedCaseString(
    element.attributes.get("name"),
    `${sourcePath} testcase name`,
    4_096,
    true,
  )
  if (!name) throw new Error(`${sourcePath} contains a testcase without a name`)
  const fileValue = boundedCaseString(
    element.attributes.get("file"),
    `${sourcePath} testcase ${name} file`,
    1_024,
    true,
  )
  if (!fileValue) throw new Error(`${sourcePath} testcase ${name} has no file`)
  const className = boundedCaseString(
    element.attributes.get("classname"),
    `${sourcePath} testcase ${name} classname`,
    4_096,
    false,
  )
  if (element.hasNonWhitespaceText) {
    throw new Error(`${sourcePath} testcase ${name} contains unsupported direct text`)
  }

  const allowedChildren = new Set(["failure", "error", "skipped", "system-out", "system-err"])
  for (const child of element.children) {
    if (!allowedChildren.has(child.name)) {
      throw new Error(`${sourcePath} testcase ${name} contains unsupported element <${child.name}>`)
    }
    if (child.children.length > 0) {
      throw new Error(`${sourcePath} testcase ${name} contains a nested <${child.name}> element`)
    }
  }
  const terminalChildren = element.children.filter(
    (child) => child.name === "failure" || child.name === "error" || child.name === "skipped",
  )
  if (terminalChildren.length > 1) {
    throw new Error(`${sourcePath} gives testcase ${name} multiple terminal states`)
  }
  const childStatus: TestStatus | null =
    terminalChildren[0]?.name === "failure"
      ? "failed"
      : terminalChildren[0]?.name === "error"
        ? "error"
        : terminalChildren[0]?.name === "skipped"
          ? "skipped"
          : null

  const statusValues = [element.attributes.get("status"), element.attributes.get("result")]
    .filter((value): value is string => value !== undefined)
    .map((value) => statusFromAttribute(value, sourcePath, name))
  if (new Set(statusValues).size > 1) {
    throw new Error(`${sourcePath} gives testcase ${name} conflicting status attributes`)
  }
  const attributeStatus = statusValues[0] ?? null
  if (childStatus && attributeStatus && childStatus !== attributeStatus) {
    throw new Error(`${sourcePath} gives testcase ${name} conflicting child and attribute states`)
  }
  return {
    name,
    className,
    file: normalizeTestFile(fileValue, `${sourcePath} testcase ${name} file`),
    status: childStatus ?? attributeStatus ?? "passed",
  }
}

function addCounts(left: SuiteCounts, right: SuiteCounts): SuiteCounts {
  return {
    tests: left.tests + right.tests,
    passed: left.passed + right.passed,
    failed: left.failed + right.failed,
    errors: left.errors + right.errors,
    skipped: left.skipped + right.skipped,
  }
}

function statusCounts(status: TestStatus): SuiteCounts {
  return {
    tests: 1,
    passed: status === "passed" ? 1 : 0,
    failed: status === "failed" ? 1 : 0,
    errors: status === "error" ? 1 : 0,
    skipped: status === "skipped" ? 1 : 0,
  }
}

function assertDeclaredCounts(element: XmlElement, actual: SuiteCounts, sourcePath: string): void {
  const declared = {
    tests: declaredCount(element.attributes, "tests", sourcePath, true),
    failures: declaredCount(element.attributes, "failures", sourcePath, true),
    errors: declaredCount(element.attributes, "errors", sourcePath, actual.errors > 0),
    skipped: declaredCount(element.attributes, "skipped", sourcePath, true),
  }
  const mismatches: string[] = []
  if (declared.tests !== actual.tests) mismatches.push(`tests ${declared.tests} != ${actual.tests}`)
  if (declared.failures !== actual.failed) {
    mismatches.push(`failures ${declared.failures} != ${actual.failed}`)
  }
  if (declared.errors !== null && declared.errors !== actual.errors) {
    mismatches.push(`errors ${declared.errors} != ${actual.errors}`)
  }
  if (declared.skipped !== actual.skipped) {
    mismatches.push(`skipped ${declared.skipped} != ${actual.skipped}`)
  }
  if (mismatches.length > 0) {
    throw new Error(`${sourcePath} has inconsistent declared counts: ${mismatches.join(", ")}`)
  }
}

function assertLeafContainer(element: XmlElement, sourcePath: string): void {
  if (element.children.length > 0) {
    throw new Error(`${sourcePath} contains unsupported nested content in <${element.name}>`)
  }
}

function assertStructuralWhitespace(element: XmlElement, sourcePath: string): void {
  if (element.hasNonWhitespaceText) {
    throw new Error(`${sourcePath} contains unsupported direct text in <${element.name}>`)
  }
}

function analyzeSuite(
  element: XmlElement,
  sourcePath: string,
  cases: TestCaseResult[],
): SuiteCounts {
  assertStructuralWhitespace(element, sourcePath)
  const allowed = new Set(["testsuite", "testcase", "properties", "system-out", "system-err"])
  let aggregate: SuiteCounts = { tests: 0, passed: 0, failed: 0, errors: 0, skipped: 0 }
  for (const child of element.children) {
    if (!allowed.has(child.name)) {
      throw new Error(`${sourcePath} contains unsupported element <${child.name}>`)
    }
    if (child.name === "testsuite") {
      const suiteName = boundedCaseString(
        child.attributes.get("name"),
        "testsuite name",
        4_096,
        false,
      )
      const childPath = `${sourcePath} > testsuite${suiteName ? ` ${suiteName}` : ""}`
      aggregate = addCounts(aggregate, analyzeSuite(child, childPath, cases))
    } else if (child.name === "testcase") {
      if (cases.length >= MAX_TOTAL_TESTCASES) {
        throw new Error(`${sourcePath} exceeds the testcase limit`)
      }
      const testCase = parseTestCase(child, sourcePath)
      cases.push(testCase)
      aggregate = addCounts(aggregate, statusCounts(testCase.status))
    } else if (child.name === "properties") {
      assertStructuralWhitespace(child, sourcePath)
      for (const property of child.children) {
        if (property.name !== "property") {
          throw new Error(`${sourcePath} contains unsupported properties child <${property.name}>`)
        }
        assertLeafContainer(property, sourcePath)
        assertStructuralWhitespace(property, sourcePath)
      }
    } else {
      assertLeafContainer(child, sourcePath)
    }
  }
  assertDeclaredCounts(element, aggregate, sourcePath)
  return aggregate
}

function parseJUnit(xml: string, sourcePath: string): readonly TestCaseResult[] {
  const root = parseXmlDocument(xml, sourcePath)
  if (root.name !== "testsuites" && root.name !== "testsuite") {
    throw new Error(`${sourcePath} is not a JUnit testsuite document`)
  }
  const cases: TestCaseResult[] = []
  if (root.name === "testsuite") {
    analyzeSuite(root, sourcePath, cases)
  } else {
    assertStructuralWhitespace(root, sourcePath)
    const allowed = new Set(["testsuite", "properties", "system-out", "system-err"])
    let aggregate: SuiteCounts = { tests: 0, passed: 0, failed: 0, errors: 0, skipped: 0 }
    for (const child of root.children) {
      if (!allowed.has(child.name)) {
        throw new Error(`${sourcePath} contains unsupported root element <${child.name}>`)
      }
      if (child.name === "testsuite") {
        const suiteName = boundedCaseString(
          child.attributes.get("name"),
          "testsuite name",
          4_096,
          false,
        )
        const childPath = `${sourcePath} > testsuite${suiteName ? ` ${suiteName}` : ""}`
        aggregate = addCounts(aggregate, analyzeSuite(child, childPath, cases))
      } else if (child.name === "properties") {
        assertStructuralWhitespace(child, sourcePath)
        for (const property of child.children) {
          if (property.name !== "property") {
            throw new Error(
              `${sourcePath} contains unsupported properties child <${property.name}>`,
            )
          }
          assertLeafContainer(property, sourcePath)
          assertStructuralWhitespace(property, sourcePath)
        }
      } else {
        assertLeafContainer(child, sourcePath)
      }
    }
    assertDeclaredCounts(root, aggregate, sourcePath)
  }
  if (cases.length === 0) throw new Error(`${sourcePath} contains zero testcases`)
  return cases
}

function validCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

function waiverKey(waiver: Waiver): string {
  return [
    waiver.kind,
    waiver.report,
    waiver.file,
    waiver.testName,
    waiver.os,
    waiver.architecture,
  ].join("\0")
}

function skippedCaseKey(
  kind: string,
  report: string,
  testCase: TestCaseResult,
  os: CiOs,
  architecture: CiArchitecture,
): string {
  return [kind, report, testCase.file, testCase.name, os, architecture].join("\0")
}

async function loadReports(
  input: string,
  expected: readonly string[],
): Promise<readonly ParsedReport[]> {
  const information = await lstat(input)
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error(`JUnit input must be a non-symlink directory: ${input}`)
  }
  const entries = await readdir(input, { withFileTypes: true })
  const xmlEntries = entries.filter((entry) => entry.name.toLowerCase().endsWith(".xml"))
  if (xmlEntries.length > MAX_REPORTS) {
    throw new Error(`JUnit input exceeds the ${MAX_REPORTS}-report limit`)
  }
  const invalidXmlEntries = xmlEntries.filter((entry) => !entry.isFile())
  if (invalidXmlEntries.length > 0) {
    throw new Error(
      `JUnit inputs must be regular files: ${invalidXmlEntries.map((entry) => entry.name).join(", ")}`,
    )
  }
  const names = xmlEntries
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"))
  const missing = expected.filter((name) => !names.includes(name))
  const unexpected = names.filter((name) => !expected.includes(name))
  if (missing.length > 0 || unexpected.length > 0) {
    const details = [
      missing.length > 0 ? `missing: ${missing.join(", ")}` : null,
      unexpected.length > 0 ? `unexpected: ${unexpected.join(", ")}` : null,
    ].filter((value): value is string => value !== null)
    throw new Error(`JUnit report set does not exactly match --expect (${details.join("; ")})`)
  }

  let totalBytes = 0
  let totalCases = 0
  const reports: ParsedReport[] = []
  for (const name of names) {
    const path = resolve(input, name)
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error(`JUnit input must remain a regular file: ${name}`)
    }
    if (before.size > MAX_REPORT_BYTES) {
      throw new Error(`${name} exceeds the ${MAX_REPORT_BYTES}-byte report limit`)
    }
    totalBytes += before.size
    if (totalBytes > MAX_TOTAL_REPORT_BYTES) {
      throw new Error(`JUnit reports exceed the ${MAX_TOTAL_REPORT_BYTES}-byte total limit`)
    }
    const bytes = await readFile(path)
    const after = await lstat(path)
    if (
      bytes.byteLength !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw new Error(`JUnit input changed while being read: ${name}`)
    }
    let xml: string
    try {
      xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
      throw new Error(`${name} is not valid UTF-8`)
    }
    const cases = parseJUnit(xml, name)
    totalCases += cases.length
    if (totalCases > MAX_TOTAL_TESTCASES) {
      throw new Error(`JUnit reports exceed the ${MAX_TOTAL_TESTCASES}-testcase total limit`)
    }
    reports.push({
      name,
      path: portableProjectPath(path),
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      cases,
    })
  }
  return reports
}

async function loadWaiverManifest(path: string): Promise<{
  readonly bytes: Uint8Array
  readonly schemaVersion: 2
  readonly waivers: readonly Waiver[]
}> {
  const information = await lstat(path)
  if (!information.isFile() || information.isSymbolicLink()) {
    throw new Error(`Waiver manifest must be a regular non-symlink file: ${path}`)
  }
  if (information.size > MAX_MANIFEST_BYTES) {
    throw new Error(`Waiver manifest exceeds the ${MAX_MANIFEST_BYTES}-byte limit`)
  }
  const bytes = await readFile(path)
  let source: string
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new Error("Waiver manifest is not valid UTF-8")
  }
  const parsed = WaiverManifestSchema.parse(JSON.parse(source))
  const waivers = parsed.waivers.map((waiver) => ({
    ...waiver,
    report: normalizedReportName(waiver.report, "Waiver report"),
    file: normalizeTestFile(waiver.file, `Waiver file for ${waiver.testName}`),
  }))
  const keys = new Set<string>()
  const duplicates = new Set<string>()
  for (const waiver of waivers) {
    if (!validCalendarDate(waiver.expiresOn)) {
      throw new Error(
        `Waiver for ${waiver.testName} has an invalid expiry date: ${waiver.expiresOn}`,
      )
    }
    const key = waiverKey(waiver)
    if (keys.has(key)) duplicates.add(key.replaceAll("\0", " / "))
    keys.add(key)
  }
  if (duplicates.size > 0) {
    throw new Error(`Duplicate JUnit skip waivers: ${[...duplicates].sort().join(", ")}`)
  }
  return { bytes, schemaVersion: parsed.schemaVersion, waivers }
}

const options = parseArguments(process.argv.slice(2))
const input = insideProject(options.input, "JUnit input")
const output = insideProject(options.output, "Classification output")
const waiverPath = insideProject(options.waivers, "Waiver manifest")
const os = normalizeOs(process.platform)
const architecture = normalizeArchitecture(process.arch)
if (options.expectedOs && normalizeOs(options.expectedOs) !== os) {
  throw new Error(`Runner OS ${os} does not match expected OS ${options.expectedOs}`)
}
if (
  options.expectedArchitecture &&
  normalizeArchitecture(options.expectedArchitecture) !== architecture
) {
  throw new Error(
    `Runner architecture ${architecture} does not match expected architecture ${options.expectedArchitecture}`,
  )
}

const manifest = await loadWaiverManifest(waiverPath)
const reports = await loadReports(input, options.expectedReports)
const today = new Date().toISOString().slice(0, 10)
const expectedReportSet = new Set(options.expectedReports)
const relevantWaivers = manifest.waivers.filter(
  (waiver) =>
    waiver.kind === options.kind &&
    waiver.os === os &&
    waiver.architecture === architecture &&
    expectedReportSet.has(waiver.report),
)
const relevantByKey = new Map(relevantWaivers.map((waiver) => [waiverKey(waiver), waiver]))
const consumedWaiverKeys = new Set<string>()

const allCases = reports.flatMap((report) =>
  report.cases.map((testCase) => ({ ...testCase, report: report.path, reportName: report.name })),
)
const skippedCases = allCases.filter((testCase) => testCase.status === "skipped")
const skippedIdentities = new Set<string>()
for (const testCase of skippedCases) {
  const key = skippedCaseKey(options.kind, testCase.reportName, testCase, os, architecture)
  if (skippedIdentities.has(key)) {
    throw new Error(
      `Duplicate skipped testcase identity cannot share one waiver: ${testCase.reportName}/` +
        `${testCase.file}/${testCase.name}`,
    )
  }
  skippedIdentities.add(key)
}
const skipped = skippedCases.map((testCase) => {
  const key = skippedCaseKey(options.kind, testCase.reportName, testCase, os, architecture)
  const waiver = relevantByKey.get(key)
  if (waiver) consumedWaiverKeys.add(key)
  const disposition = !waiver
    ? "missing-waiver"
    : waiver.expiresOn < today
      ? "expired-waiver"
      : "waived"
  return {
    report: testCase.report,
    reportName: testCase.reportName,
    name: testCase.name,
    className: testCase.className,
    file: testCase.file,
    disposition,
    waiver: waiver
      ? {
          kind: waiver.kind,
          report: waiver.report,
          file: waiver.file,
          os: waiver.os,
          architecture: waiver.architecture,
          owner: waiver.owner,
          rationale: waiver.rationale,
          approvalRef: waiver.approvalRef,
          expiresOn: waiver.expiresOn,
        }
      : null,
  }
})

const unusedWaivers = relevantWaivers
  .filter((waiver) => !consumedWaiverKeys.has(waiverKey(waiver)))
  .map((waiver) => ({
    kind: waiver.kind,
    report: waiver.report,
    file: waiver.file,
    testName: waiver.testName,
    os: waiver.os,
    architecture: waiver.architecture,
    owner: waiver.owner,
    approvalRef: waiver.approvalRef,
    expiresOn: waiver.expiresOn,
  }))
const expiredWaivers = relevantWaivers
  .filter((waiver) => waiver.expiresOn < today)
  .map((waiver) => ({
    kind: waiver.kind,
    report: waiver.report,
    file: waiver.file,
    testName: waiver.testName,
    os: waiver.os,
    architecture: waiver.architecture,
    owner: waiver.owner,
    approvalRef: waiver.approvalRef,
    expiresOn: waiver.expiresOn,
  }))

const counts = {
  tests: allCases.length,
  passed: allCases.filter((testCase) => testCase.status === "passed").length,
  failed: allCases.filter((testCase) => testCase.status === "failed").length,
  errors: allCases.filter((testCase) => testCase.status === "error").length,
  skipped: skipped.length,
  waivedSkips: skipped.filter((item) => item.disposition === "waived").length,
  unwaivedSkips: skipped.filter((item) => item.disposition !== "waived").length,
}
const configurationIssues = [
  ...expiredWaivers.map(
    (waiver) =>
      `expired relevant waiver ${waiver.kind}/${waiver.report}/${waiver.file}/${waiver.testName}/${waiver.os}/${waiver.architecture} (${waiver.expiresOn})`,
  ),
  ...unusedWaivers.map(
    (waiver) =>
      `unused relevant waiver ${waiver.kind}/${waiver.report}/${waiver.file}/${waiver.testName}/${waiver.os}/${waiver.architecture}`,
  ),
]
const failed =
  counts.failed > 0 ||
  counts.errors > 0 ||
  counts.unwaivedSkips > 0 ||
  configurationIssues.length > 0
const status = failed ? "fail" : counts.waivedSkips > 0 ? "pass-with-waivers" : "pass"
const classification = {
  schemaVersion: 2,
  artifactClass: "ci-test-classification",
  status,
  kind: options.kind,
  policy: {
    skippedTestsCountAsPassed: false,
    unwaivedSkipFailsGate: true,
    relevantUnusedWaiverFailsGate: true,
    waiverScope: "kind-report-file-test-name-os-architecture",
    expiryDateInclusive: true,
    exactExpectedReportSet: true,
    strictBoundedXml: true,
  },
  limits: {
    reports: MAX_REPORTS,
    bytesPerReport: MAX_REPORT_BYTES,
    totalReportBytes: MAX_TOTAL_REPORT_BYTES,
    totalTestcases: MAX_TOTAL_TESTCASES,
    xmlDepth: MAX_XML_DEPTH,
    xmlElementsPerReport: MAX_XML_ELEMENTS_PER_REPORT,
  },
  generatedAt: new Date().toISOString(),
  runner: { os, architecture },
  expectedReports: [...options.expectedReports],
  counts,
  reports: reports.map((report) => ({
    name: report.name,
    path: report.path,
    bytes: report.bytes,
    sha256: report.sha256,
    counts: {
      tests: report.cases.length,
      passed: report.cases.filter((testCase) => testCase.status === "passed").length,
      failed: report.cases.filter((testCase) => testCase.status === "failed").length,
      errors: report.cases.filter((testCase) => testCase.status === "error").length,
      skipped: report.cases.filter((testCase) => testCase.status === "skipped").length,
    },
  })),
  waiverManifest: {
    schemaVersion: manifest.schemaVersion,
    path: portableProjectPath(waiverPath),
    bytes: manifest.bytes.byteLength,
    sha256: createHash("sha256").update(manifest.bytes).digest("hex"),
    entries: manifest.waivers.length,
    relevantEntries: relevantWaivers.length,
    ignoredEntries: manifest.waivers.length - relevantWaivers.length,
    consumedEntries: consumedWaiverKeys.size,
  },
  skipped,
  unusedWaivers,
  expiredWaivers,
  configurationIssues,
}

await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(classification, null, 2)}\n`, "utf8")
process.stdout.write(
  `${JSON.stringify({
    status,
    kind: options.kind,
    runner: { os, architecture },
    counts,
    output: portableProjectPath(output),
  })}\n`,
)
if (failed) process.exitCode = 1
