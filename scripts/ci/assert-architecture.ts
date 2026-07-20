const supportedArchitectures = new Set(["x64", "arm64"])

function parseExpectedArchitecture(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== "--expected" || !argv[1]) {
    throw new Error("Usage: assert-architecture.ts --expected <x64|arm64>")
  }
  if (!supportedArchitectures.has(argv[1])) {
    throw new Error(`Unsupported expected architecture: ${argv[1]}`)
  }
  return argv[1]
}

const expected = parseExpectedArchitecture(process.argv.slice(2))
const observed = process.arch
if (observed !== expected) {
  throw new Error(`Native architecture mismatch: expected ${expected}, observed ${observed}`)
}

process.stdout.write(`${JSON.stringify({ architecture: observed, status: "pass" })}\n`)
