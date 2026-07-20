import { ToolRegistry } from "./registry"
import { artifactPublishTool } from "./tools/artifact"
import { filesystemTools } from "./tools/fs"
import { gitInspectTool } from "./tools/git"
import { processExecTool } from "./tools/process"

/** Creates a fresh registry containing exactly the ten Ralph v2 core tools. */
export function createBuiltinToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  for (const tool of filesystemTools()) registry.register(tool)
  registry.register(processExecTool())
  registry.register(gitInspectTool())
  registry.register(artifactPublishTool())
  return registry
}
