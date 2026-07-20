import { constants } from "node:fs"
import { lstat, open, unlink } from "node:fs/promises"
import { resolve } from "node:path"

const MAX_STORED_BLOCK = 65_535
const MAX_INPUT_BYTES = 4 * 1024 * 1024 * 1024

const CRC32_TABLE = new Uint32Array(256)
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  CRC32_TABLE[index] = value >>> 0
}

function updateCrc32(current: number, bytes: Uint8Array): number {
  let value = current
  for (const byte of bytes) {
    value = (CRC32_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8)
  }
  return value >>> 0
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array,
  position: number,
): Promise<number> {
  let written = 0
  while (written < bytes.byteLength) {
    const result = await handle.write(
      bytes,
      written,
      bytes.byteLength - written,
      position + written,
    )
    if (result.bytesWritten <= 0) throw new Error("Deterministic gzip write made no progress")
    written += result.bytesWritten
  }
  return position + written
}

/**
 * Writes a portable gzip stream using DEFLATE stored blocks. It intentionally
 * trades compression ratio for byte-for-byte reproducibility without relying
 * on a host zlib build. MTIME is zero and the OS byte is 255 (unknown).
 */
export async function createDeterministicGzip(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  const source = resolve(sourcePath)
  const destination = resolve(destinationPath)
  if (source === destination) {
    throw new Error(`Deterministic gzip source and destination must differ: ${source}`)
  }
  const initial = await lstat(source).catch(() => undefined)
  if (
    !initial?.isFile() ||
    initial.isSymbolicLink() ||
    !Number.isSafeInteger(initial.size) ||
    initial.size <= 0 ||
    initial.size > MAX_INPUT_BYTES
  ) {
    throw new Error(`Deterministic gzip source must be a bounded regular file: ${source}`)
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
  const input = await open(source, constants.O_RDONLY | noFollow)
  let output: Awaited<ReturnType<typeof open>> | undefined
  let destinationCreated = false
  try {
    const opened = await input.stat()
    if (
      !opened.isFile() ||
      opened.dev !== initial.dev ||
      opened.ino !== initial.ino ||
      opened.size !== initial.size ||
      opened.mtimeMs !== initial.mtimeMs ||
      opened.ctimeMs !== initial.ctimeMs
    ) {
      throw new Error(`Deterministic gzip source changed before open: ${source}`)
    }
    output = await open(destination, "wx", 0o600)
    destinationCreated = true
    let outputPosition = await writeAll(
      output,
      Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]),
      0,
    )
    const buffer = Buffer.allocUnsafe(MAX_STORED_BLOCK)
    let inputPosition = 0
    let crc32 = 0xffffffff
    while (inputPosition < opened.size) {
      const maximum = Math.min(buffer.byteLength, opened.size - inputPosition)
      const result = await input.read(buffer, 0, maximum, inputPosition)
      if (result.bytesRead <= 0) throw new Error(`Deterministic gzip source ended early: ${source}`)
      const chunk = buffer.subarray(0, result.bytesRead)
      inputPosition += result.bytesRead
      const header = Buffer.allocUnsafe(5)
      header[0] = inputPosition === opened.size ? 0x01 : 0x00
      header.writeUInt16LE(result.bytesRead, 1)
      header.writeUInt16LE(~result.bytesRead & 0xffff, 3)
      outputPosition = await writeAll(output, header, outputPosition)
      outputPosition = await writeAll(output, chunk, outputPosition)
      crc32 = updateCrc32(crc32, chunk)
    }
    const extra = Buffer.allocUnsafe(1)
    if ((await input.read(extra, 0, 1, opened.size)).bytesRead !== 0) {
      throw new Error(`Deterministic gzip source grew while reading: ${source}`)
    }
    const settled = await input.stat()
    if (
      settled.dev !== opened.dev ||
      settled.ino !== opened.ino ||
      settled.size !== opened.size ||
      settled.mtimeMs !== opened.mtimeMs ||
      settled.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(`Deterministic gzip source changed while reading: ${source}`)
    }
    const trailer = Buffer.allocUnsafe(8)
    trailer.writeUInt32LE((crc32 ^ 0xffffffff) >>> 0, 0)
    trailer.writeUInt32LE(opened.size >>> 0, 4)
    outputPosition = await writeAll(output, trailer, outputPosition)
    await output.truncate(outputPosition)
    await output.chmod(0o644)
    await output.sync()
    await output.close()
    output = undefined
  } catch (error) {
    if (output) await output.close().catch(() => undefined)
    if (destinationCreated) await unlink(destination).catch(() => undefined)
    throw error
  } finally {
    await input.close()
  }
}
