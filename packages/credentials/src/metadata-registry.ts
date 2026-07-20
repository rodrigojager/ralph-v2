import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"
import { writePrivateFileAtomic } from "./atomic-file"
import type { CredentialMetadataDocument, CredentialRef } from "./contracts"
import { CredentialMetadataDocumentSchema, CredentialRefSchema } from "./contracts"

const EMPTY_DOCUMENT: CredentialMetadataDocument = { schemaVersion: 1, credentials: [] }
const LOCK_WAIT_MS = 5_000
const LOCK_STALE_MS = 120_000
const LOCK_POLL_MS = 25

export class CredentialMetadataRegistry {
  #serial: Promise<void> = Promise.resolve()

  constructor(readonly file: string) {}

  async list(): Promise<CredentialRef[]> {
    await this.#serial
    return (await this.read()).credentials.map((credential) => ({ ...credential }))
  }

  async get(id: string): Promise<CredentialRef | undefined> {
    return (await this.list()).find((credential) => credential.id === id)
  }

  async upsert(ref: CredentialRef, forbiddenSecrets: readonly string[] = []): Promise<void> {
    const parsed = CredentialRefSchema.parse(ref)
    this.assertNoSecret(parsed, forbiddenSecrets)
    await this.mutate(async () => {
      const document = await this.read()
      const credentials = document.credentials.filter((credential) => credential.id !== parsed.id)
      credentials.push(parsed)
      credentials.sort((left, right) =>
        `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`),
      )
      await this.write({ schemaVersion: 1, credentials })
    })
  }

  async insert(ref: CredentialRef, forbiddenSecrets: readonly string[] = []): Promise<void> {
    const parsed = CredentialRefSchema.parse(ref)
    this.assertNoSecret(parsed, forbiddenSecrets)
    await this.mutate(async () => {
      const document = await this.read()
      if (document.credentials.some((credential) => credential.id === parsed.id)) {
        throw new Error(`Credential ID is already registered: ${parsed.id}`)
      }
      const credentials = [...document.credentials, parsed]
      credentials.sort((left, right) =>
        `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`),
      )
      await this.write({ schemaVersion: 1, credentials })
    })
  }

  async remove(id: string): Promise<void> {
    await this.mutate(async () => {
      const document = await this.read()
      const credentials = document.credentials.filter((credential) => credential.id !== id)
      if (credentials.length === document.credentials.length) return
      await this.write({ schemaVersion: 1, credentials })
    })
  }

  private async read(): Promise<CredentialMetadataDocument> {
    let content: string
    try {
      content = await readFile(this.file, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_DOCUMENT
      throw error
    }
    try {
      return CredentialMetadataDocumentSchema.parse(JSON.parse(content))
    } catch (error) {
      throw new Error(`Credential metadata registry is invalid: ${this.file}`, { cause: error })
    }
  }

  private async write(document: CredentialMetadataDocument): Promise<void> {
    const parsed = CredentialMetadataDocumentSchema.parse(document)
    await writePrivateFileAtomic(this.file, `${JSON.stringify(parsed, null, 2)}\n`)
  }

  private assertNoSecret(ref: CredentialRef, forbiddenSecrets: readonly string[]): void {
    const serialized = JSON.stringify(ref)
    for (const secret of forbiddenSecrets) {
      if (secret.length >= 4 && serialized.includes(secret)) {
        throw new Error("Credential metadata contains secret material")
      }
    }
  }

  private async mutate(operation: () => Promise<void>): Promise<void> {
    const guarded = () => this.withFileLock(operation)
    const next = this.#serial.then(guarded, guarded)
    this.#serial = next.catch(() => undefined)
    await next
  }

  private async withFileLock(operation: () => Promise<void>): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const lockFile = `${this.file}.lock`
    const token = `${process.pid}:${crypto.randomUUID()}`
    const deadline = Date.now() + LOCK_WAIT_MS

    while (true) {
      try {
        const handle = await open(lockFile, "wx", 0o600)
        try {
          await handle.writeFile(token, "utf8")
          await handle.sync()
        } finally {
          await handle.close()
        }
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        const info = await lstat(lockFile).catch((cause: NodeJS.ErrnoException) => {
          if (cause.code === "ENOENT") return undefined
          throw cause
        })
        if (!info) continue
        if (!info.isFile() || info.isSymbolicLink()) {
          throw new Error("Credential metadata lock is not a regular file")
        }
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          const stale = `${lockFile}.${crypto.randomUUID()}.stale`
          try {
            await rename(lockFile, stale)
            await rm(stale, { force: true })
          } catch (cause) {
            if (
              !["ENOENT", "EACCES", "EPERM"].includes((cause as NodeJS.ErrnoException).code ?? "")
            ) {
              throw cause
            }
          }
          continue
        }
        if (Date.now() >= deadline) {
          throw new Error("Credential metadata registry is busy in another Ralph process")
        }
        await Bun.sleep(LOCK_POLL_MS)
      }
    }

    try {
      await operation()
    } finally {
      const owner = await readFile(lockFile, "utf8").catch(() => undefined)
      if (owner === token) await rm(lockFile, { force: true })
    }
  }
}
