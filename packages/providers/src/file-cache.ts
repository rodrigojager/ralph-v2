import { lstat, mkdir, open, rename, rm } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { validateModelCatalogSnapshotIntegrity } from "./catalog"
import type { ModelCatalogCache, ModelCatalogSnapshot } from "./contracts"
import { ProviderCoreError } from "./errors"

export type FileModelCatalogCacheOptions = {
  path: string
  maximumBytes?: number
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

export class FileModelCatalogCache implements ModelCatalogCache {
  readonly path: string
  readonly #maximumBytes: number

  constructor(options: FileModelCatalogCacheOptions) {
    this.path = resolve(options.path)
    this.#maximumBytes = options.maximumBytes ?? 8 * 1024 * 1024
    if (!Number.isSafeInteger(this.#maximumBytes) || this.#maximumBytes <= 0) {
      throw new ProviderCoreError(
        "PROVIDER_CATALOG_CACHE_LIMIT_INVALID",
        "Catalog cache byte limit must be positive",
      )
    }
  }

  async read(): Promise<ModelCatalogSnapshot | undefined> {
    if (!(await exists(this.path))) return undefined
    const metadata = await lstat(this.path)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new ProviderCoreError(
        "PROVIDER_CATALOG_CACHE_TYPE_INVALID",
        "Catalog cache must be a regular file",
      )
    }
    if (metadata.size > this.#maximumBytes) {
      throw new ProviderCoreError(
        "PROVIDER_CATALOG_CACHE_TOO_LARGE",
        "Catalog cache exceeds the configured byte limit",
      )
    }
    const content = await Bun.file(this.path).text()
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      throw new ProviderCoreError(
        "PROVIDER_CATALOG_CACHE_JSON_INVALID",
        "Catalog cache is not valid JSON",
      )
    }
    return validateModelCatalogSnapshotIntegrity(parsed)
  }

  async write(snapshotInput: ModelCatalogSnapshot): Promise<void> {
    const snapshot = validateModelCatalogSnapshotIntegrity(snapshotInput)
    const content = `${JSON.stringify(snapshot, null, 2)}\n`
    if (Buffer.byteLength(content) > this.#maximumBytes) {
      throw new ProviderCoreError(
        "PROVIDER_CATALOG_CACHE_TOO_LARGE",
        "Catalog snapshot exceeds the configured byte limit",
      )
    }
    const directory = dirname(this.path)
    await mkdir(directory, { recursive: true })
    const temporary = join(
      directory,
      `.${basename(this.path)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    )
    const handle = await open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }

    let displaced: string | undefined
    try {
      try {
        await rename(temporary, this.path)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (!(["EACCES", "EEXIST", "ENOTEMPTY", "EPERM"] as const).includes(code as never)) {
          throw error
        }
        displaced = join(
          directory,
          `.${basename(this.path)}.${process.pid}.${crypto.randomUUID()}.replaced`,
        )
        await rename(this.path, displaced)
        try {
          await rename(temporary, this.path)
        } catch (replacementError) {
          await rename(displaced, this.path).catch(() => undefined)
          throw replacementError
        }
      }
    } finally {
      await rm(temporary, { force: true })
      if (displaced) await rm(displaced, { force: true })
    }
  }
}
