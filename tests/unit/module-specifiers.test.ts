import { expect, test } from "bun:test"
import { moduleSpecifiers } from "../helpers/module-specifiers"

test("module boundary parser detects every executable TypeScript import form", () => {
  const source = `
    import value from "static-default"
    import type { Type } from "static-type"
    import "side-effect"
    export { item } from "re-export"
    export * from "export-all"
    import legacy = require("import-equals")
    const dynamic = import("dynamic-import")
    const commonjs = require("commonjs-require")
    const ignored = 'import "inside-a-string"'
    // import "inside-a-comment"
  `
  expect(moduleSpecifiers(source, "fixture.ts")).toEqual([
    "static-default",
    "static-type",
    "side-effect",
    "re-export",
    "export-all",
    "import-equals",
    "dynamic-import",
    "commonjs-require",
  ])
})
