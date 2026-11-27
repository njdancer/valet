// Pulls the text out of a Messages `attributedBody`: an NSAttributedString archived with NSArchiver's
// typedstream format. Newer macOS versions leave `message.text` null and store only this blob.
// We don't parse the whole archive; the string payload follows the first NSString class name as a
// '+' (C string) tag and a typedstream integer length.

const MARKER = Buffer.from('NSString', 'latin1')
const STRING_TAG = 0x2b
// The '+' sits a few bytes after the class name (version and reference bytes in between).
const TAG_SEARCH_WINDOW = 16
const INT16 = 0x81
const INT32 = 0x82

/** The archived string, or null when the blob doesn't have the expected shape. */
export function attributedBodyText(blob: Uint8Array): string | null {
  const bytes = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength)
  const marker = bytes.indexOf(MARKER)
  if (marker < 0) return null
  const searchFrom = marker + MARKER.length
  const tag = bytes.subarray(searchFrom, searchFrom + TAG_SEARCH_WINDOW).indexOf(STRING_TAG)
  if (tag < 0) return null
  let at = searchFrom + tag + 1
  const lengthTag = bytes[at]
  if (lengthTag === undefined) return null
  let length: number
  if (lengthTag < 0x80) {
    length = lengthTag
    at += 1
  } else if (lengthTag === INT16) {
    if (at + 3 > bytes.length) return null
    length = bytes.readUInt16LE(at + 1)
    at += 3
  } else if (lengthTag === INT32) {
    if (at + 5 > bytes.length) return null
    length = bytes.readUInt32LE(at + 1)
    at += 5
  } else {
    return null
  }
  if (at + length > bytes.length) return null
  return bytes.toString('utf8', at, at + length)
}
