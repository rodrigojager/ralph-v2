import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, resolve } from "node:path"

const TEST_DIRECTORY_PREFIX = "ralph-v2-test-"

export async function createTestDirectory(): Promise<string> {
  return realpath(await mkdtemp(resolve(tmpdir(), TEST_DIRECTORY_PREFIX)))
}

export async function removeTestDirectory(path: string): Promise<void> {
  const target = resolve(path)
  const temporaryRoot = await realpath(resolve(tmpdir()))
  if (dirname(target) !== temporaryRoot || !basename(target).startsWith(TEST_DIRECTORY_PREFIX)) {
    throw new Error(`Refusing to remove a directory outside the Ralph test namespace: ${target}`)
  }
  // Windows scanners and recently closed subprocess handles can transiently
  // retain a directory. Node/Bun's bounded recursive retry applies only after
  // the namespace check above, so cleanup stays safe without making EBUSY a
  // false product failure.
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
