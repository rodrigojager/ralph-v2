import { resolve } from "node:path"
import {
  conciseHarnessResult,
  parseHarnessOptions,
  runCompatibilityHarness,
  writeCompatibilityReports,
} from "./compatibility-core"

const projectRoot = resolve(import.meta.dir, "..")

try {
  const options = parseHarnessOptions(process.argv.slice(2), projectRoot)
  const report = await runCompatibilityHarness(options, projectRoot)
  const paths = options.writeReports
    ? await writeCompatibilityReports(report, options.outputDirectory)
    : null
  const output = options.printJson ? report : { ...conciseHarnessResult(report), reports: paths }
  console.log(JSON.stringify(output, null, 2))
  if (report.summary.regressions > 0) process.exitCode = 1
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Compatibility harness failed: ${message}`)
  process.exitCode = 1
}
