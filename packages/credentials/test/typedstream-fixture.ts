// Synthetic Messages attributedBody blobs, laid out like the archives macOS writes: the typedstream
// header, the NSAttributedString / NSObject / NSString class chain, the '+' string, then an
// attribute dictionary whose keys are NSStrings too.

const hex = (value: string): Buffer => Buffer.from(value.replace(/\s+/g, ''), 'hex')
const ascii = (value: string): Buffer => Buffer.from(value, 'latin1')

export type LengthEncoding = 'byte' | 'int16' | 'int32'

export function lengthBytes(length: number, encoding: LengthEncoding): Buffer {
  if (encoding === 'byte') return Buffer.from([length])
  if (encoding === 'int16') {
    const bytes = Buffer.alloc(3)
    bytes[0] = 0x81
    bytes.writeUInt16LE(length, 1)
    return bytes
  }
  const bytes = Buffer.alloc(5)
  bytes[0] = 0x82
  bytes.writeUInt32LE(length, 1)
  return bytes
}

export const ARCHIVE_PREFIX = Buffer.concat([
  hex('04 0b'),
  ascii('streamtyped'),
  hex('81 e8 03 84 01 40 84 84 84 12'),
  ascii('NSAttributedString'),
  hex('00 84 84 08'),
  ascii('NSObject'),
  hex('00 85 92 84 84 84 08'),
  ascii('NSString'),
  hex('01 94 84 01 2b'),
])

export const ARCHIVE_SUFFIX = Buffer.concat([
  hex('86 84 02 69 49 01'),
  lengthBytes(Buffer.byteLength('hello'), 'byte'),
  hex('92 84 84 84 0c'),
  ascii('NSDictionary'),
  hex('00 94 84 01 69 01 92 84 96 96 1d'),
  ascii('__kIMMessagePartAttributeName'),
  hex('86 92 84 84 84 08'),
  ascii('NSNumber'),
  hex('00 84 84 07'),
  ascii('NSValue'),
  hex('00 94 84 01 2a 84 99 99 00 86 86 86'),
])

/** An attributedBody archiving `text`, with its length written in the given encoding. */
export function archived(text: string, encoding: LengthEncoding = 'byte'): Buffer {
  const body = Buffer.from(text, 'utf8')
  return Buffer.concat([ARCHIVE_PREFIX, lengthBytes(body.length, encoding), body, ARCHIVE_SUFFIX])
}
