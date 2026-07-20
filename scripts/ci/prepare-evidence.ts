import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const projectRoot = resolve(import.meta.dir, "../..")
const evidenceRoot = join(projectRoot, "artifacts", "ci")
const junitRoot = join(evidenceRoot, "junit")

await mkdir(junitRoot, { recursive: true })
await writeFile(
  join(evidenceRoot, "evidence-contract.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      artifactClass: "ci-validation-only",
      releaseEligible: false,
      packageEligible: false,
      startedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
  { encoding: "utf8", flag: "wx" },
)
