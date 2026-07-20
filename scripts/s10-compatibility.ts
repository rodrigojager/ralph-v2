import { resolve } from "node:path"
import {
  conciseS10CompatibilityResult,
  parseS10HarnessOptions,
  renderS10CompatibilityMarkdown,
  runS10CompatibilityHarness,
  writeS10CompatibilityReports,
} from "./s10-compatibility-core"

const projectRoot = resolve(import.meta.dir, "..")

try {
  const options = parseS10HarnessOptions(process.argv.slice(2), projectRoot)
  const report = await runS10CompatibilityHarness(options, projectRoot)
  const reports = options.writeReports
    ? await writeS10CompatibilityReports(report, options.outputDirectory, projectRoot)
    : null
  if (options.format === "json") {
    console.log(JSON.stringify(report, null, 2))
  } else if (options.writeReports) {
    console.log(JSON.stringify(conciseS10CompatibilityResult(report, reports), null, 2))
  } else {
    console.log(renderS10CompatibilityMarkdown(report))
  }
  if (report.summary.regressions > 0 || report.summary.surfaceRegressions > 0) {
    process.exitCode = 1
  }
} catch (error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  console.error(`S10 compatibility harness failed: ${message}`)
  process.exitCode = 1
}
