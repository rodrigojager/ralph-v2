export interface CheckPlanOptions {
  readonly docsOutput?: string
  readonly includeDocumentation?: boolean
  readonly junitOutput?: string
}

export interface CheckStep {
  readonly id: string
  readonly label: string
  readonly command: readonly string[]
}

export function createCheckPlan(options: CheckPlanOptions = {}): readonly CheckStep[] {
  const docsArguments = options.docsOutput ? ["--output", options.docsOutput] : []
  const testArguments = options.junitOutput
    ? ["--reporter=junit", `--reporter-outfile=${options.junitOutput}`]
    : []

  const documentation: readonly CheckStep[] = options.includeDocumentation
    ? [
        {
          id: "documentation",
          label: "Markdown links and package script references",
          command: [process.execPath, "run", "scripts/check-docs.ts", ...docsArguments],
        },
      ]
    : []

  return [
    ...documentation,
    {
      id: "schemas",
      label: "Generated schema parity",
      command: [process.execPath, "run", "schemas:check"],
    },
    {
      id: "lint",
      label: "Static formatting and lint",
      command: [process.execPath, "run", "lint"],
    },
    {
      id: "typecheck",
      label: "TypeScript typecheck",
      command: [process.execPath, "run", "typecheck"],
    },
    {
      id: "tests",
      label: "Complete Bun test suite",
      command: [process.execPath, "test", ...testArguments],
    },
    {
      id: "build",
      label: "Native build",
      command: [process.execPath, "run", "build"],
    },
    {
      id: "smoke",
      label: "Native smoke",
      command: [process.execPath, "run", "smoke"],
    },
  ]
}
