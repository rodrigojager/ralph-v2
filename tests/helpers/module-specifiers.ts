/**
 * Enumerates static, side-effect, re-export, import-equals, dynamic import and
 * CommonJS require specifiers with Bun's TypeScript parser instead of regexes.
 */
export function moduleSpecifiers(source: string, fileName: string): readonly string[] {
  try {
    const parser = new Bun.Transpiler({ loader: "ts" })
    const typeImportsAsRuntime = source
      .replace(/\bimport(\s+)type\b/g, "import$1")
      .replace(/\bexport(\s+)type(?=\s*(?:\{|\*))/g, "export$1")
    return [...new Set(parser.scanImports(typeImportsAsRuntime).map((item) => item.path))]
  } catch (cause) {
    throw new Error(`Could not parse module boundaries for ${fileName}`, { cause })
  }
}
