/**
 * Locale-independent ordering for every byte-significant release surface.
 * UTF-8 byte order is stable across hosts, ICU versions and user locales.
 */
export function compareUtf8Bytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
}
