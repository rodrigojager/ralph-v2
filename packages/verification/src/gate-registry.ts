import { PluginGateIdSchema, type VerificationSpec } from "@ralph-next/prd"
import type {
  GateExecutionContext,
  GateExecutionOutcome,
  GateExecutor,
  PluginGateExecutor,
} from "./gate-contracts"

type GateType = VerificationSpec["type"]

export class GateExecutorRegistry {
  readonly #executors = new Map<GateType, GateExecutor>()
  readonly #plugins = new Map<string, PluginGateExecutor>()

  register<T extends GateType>(
    type: T,
    executor: GateExecutor<Extract<VerificationSpec, { type: T }>>,
    options: { replace?: boolean } = {},
  ): this {
    if (this.#executors.has(type) && !options.replace) {
      throw new Error(`Gate executor is already registered: ${type}`)
    }
    this.#executors.set(type, executor as GateExecutor)
    return this
  }

  registerPlugin(
    plugin: string,
    executor: PluginGateExecutor,
    options: { replace?: boolean } = {},
  ): this {
    const id = PluginGateIdSchema.parse(plugin)
    const key = `plugin:${id}`
    if (this.#plugins.has(key) && !options.replace) {
      throw new Error(`Plugin gate executor is already registered: ${key}`)
    }
    this.#plugins.set(key, executor)
    return this
  }

  has(type: GateType): boolean {
    return this.#executors.has(type)
  }

  hasPlugin(plugin: string): boolean {
    return this.#plugins.has(`plugin:${plugin}`)
  }

  pluginKeys(): string[] {
    return [...this.#plugins.keys()].sort()
  }

  async execute(
    specification: VerificationSpec,
    context: Omit<GateExecutionContext, "registry">,
  ): Promise<GateExecutionOutcome> {
    if (specification.type === "plugin") {
      const key = `plugin:${specification.plugin}`
      const plugin = this.#plugins.get(key)
      if (!plugin) {
        return {
          status: "unavailable",
          reason: `Verification plugin is not registered: ${key}`,
        }
      }
      return plugin(specification, { ...context, registry: this })
    }
    const executor = this.#executors.get(specification.type)
    if (!executor) {
      return {
        status: "unavailable",
        reason: `Gate executor is not registered: ${specification.type}`,
      }
    }
    return executor(specification, { ...context, registry: this })
  }
}
